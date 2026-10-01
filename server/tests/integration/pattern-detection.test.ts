import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { addLocalDays } from '../../src/lib/local-date.js';
import { PatternDetectionService, type DetectionLogger } from '../../src/modules/patterns/pattern-detection.service.js';
import { PatternsRepository } from '../../src/modules/patterns/patterns.repository.js';
import { DailySummariesRepository } from '../../src/modules/summaries/daily-summaries.repository.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * A detection run against PostgreSQL: day summaries in, patterns persisted, reconciled and
 * left idempotent. The summaries are written with `DailySummariesRepository.upsert` — the
 * same rows the server derives from logs (that derivation has its own tests) — so each
 * scenario can say exactly which pair holds in which window.
 */
describe.skipIf(!hasDatabase)('pattern detection run', () => {
  let harness: DatabaseHarness;
  let patterns: PatternsRepository;
  let summaries: DailySummariesRepository;
  let service: PatternDetectionService;
  const logs: { info: object[]; error: object[] } = { info: [], error: [] };

  const userA = testUserId('a');
  const userB = testUserId('b');
  // 05:00 UTC is 12:00 in Ho Chi Minh City: the user's today is 15 June, so 14 June is closed.
  const NOW = new Date('2026-06-15T05:00:00Z');

  const MARCH = '2026-03-01'; // first day of the first 30-day window, which ends 30 March
  const END_1 = '2026-03-30';
  const END_2 = '2026-04-29'; // the next 30 days

  const GAP_MEALS = 'correlation:logging_gap_hours:meals_logged';
  const MOOD_ADHERENCE = 'correlation:mood_score:plan_adherence_pct';
  const MOODS = ['low', 'okay', 'good', 'great'] as const;

  type Shape = 'related' | 'flat';

  /**
   * `days` day summaries from `from`. A related pair moves together strongly enough to
   * pass every gate; a flat pair is constant, so it has no variance and cannot.
   */
  async function seed(userId: string, from: string, days: number, shape: { gap: Shape; mood: Shape }) {
    for (let i = 0; i < days; i++) {
      const gap = shape.gap === 'related' ? 2 + (i % 12) : 5;
      const meals = shape.gap === 'related' ? Math.max(0, 5 - Math.floor(gap / 3)) : 3;
      const mood = shape.mood === 'related' ? (i % 4) + 1 : 2;
      const adherence = shape.mood === 'related' ? mood * 20 + (i % 3) * 5 : 60;
      await summaries.upsert(userId, addLocalDays(from, i), {
        eventsLogged: 4,
        mealsLogged: meals,
        waterMl: null,
        distinctFoods: null,
        vegetableServings: null,
        proteinServings: null,
        sleepMinutes: null,
        firstMealTime: null,
        lastMealTime: null,
        bedtime: null,
        planAdherencePct: String(adherence),
        mood: MOODS[mood - 1]!,
        metrics: { logging_gap_hours: gap },
      });
    }
  }

  const statuses = async (userId: string) =>
    Object.fromEntries(
      (await harness.sql`select key, status from patterns where user_id = ${userId} order by key`).map((r) => [
        r['key'],
        r['status'],
      ]),
    );
  const count = async () => (await harness.sql`select count(*)::int as c from patterns`)[0]?.['c'];

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    const db = harness.database.db;
    patterns = new PatternsRepository(db);
    summaries = new DailySummariesRepository(db);
    const logger: DetectionLogger = {
      info: (context) => logs.info.push(context),
      error: (context) => logs.error.push(context),
    };
    service = new PatternDetectionService({
      users: new UsersRepository(db),
      summaries,
      patterns,
      logger,
      now: () => NOW,
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    logs.info.length = 0;
    logs.error.length = 0;
    for (const [sub, email] of [
      [userA, 'a@example.com'],
      [userB, 'b@example.com'],
    ] as const) {
      const token = await signTestToken({ sub, email });
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
  });

  it('persists what the approved detectors emit for a closed day', async () => {
    await seed(userA, MARCH, 30, { gap: 'related', mood: 'related' });
    const result = await service.runForUser(userA, END_1);

    expect(result).toMatchObject({
      userId: userA,
      targetDate: END_1,
      windowStart: MARCH,
      windowEnd: END_1,
      detectorsRun: ['correlation'],
      detectionsEmitted: 2,
      patternsCreated: 2,
      patternsStaled: 0,
    });
    expect(await statuses(userA)).toEqual({ [GAP_MEALS]: 'active', [MOOD_ADHERENCE]: 'active' });
    const rows = await harness.sql`select window_end::text as e, last_detected_at from patterns where user_id = ${userA}`;
    for (const row of rows) expect(row).toMatchObject({ e: END_1, last_detected_at: NOW });
    expect(logs.info).toEqual([expect.objectContaining({ userId: userA, detectionsEmitted: 2, patternsCreated: 2 })]);
  });

  it('completes a run that finds nothing — zero detections, not a failure', async () => {
    await seed(userA, MARCH, 30, { gap: 'flat', mood: 'flat' });
    const result = await service.runForUser(userA, END_1);

    expect(result).toMatchObject({ detectionsEmitted: 0, patternsCreated: 0, patternsStaled: 0 });
    expect(await count()).toBe(0);
    expect(logs.error).toEqual([]);
  });

  it('is idempotent: the same user and day twice leaves one row per pattern', async () => {
    await seed(userA, MARCH, 30, { gap: 'related', mood: 'related' });
    await service.runForUser(userA, END_1);
    const before = await harness.sql`select id, key, first_detected_at, status_changed_at from patterns order by key`;
    const again = await service.runForUser(userA, END_1);

    expect(again).toMatchObject({ detectionsEmitted: 2, patternsCreated: 0, patternsRedetected: 2, patternsStaled: 0 });
    expect(await harness.sql`select id, key, first_detected_at, status_changed_at from patterns order by key`).toEqual(before);
  });

  it('stales an active pattern the run no longer returns, and keeps the one it does', async () => {
    await seed(userA, MARCH, 30, { gap: 'related', mood: 'related' });
    await seed(userA, addLocalDays(END_1, 1), 30, { gap: 'flat', mood: 'related' });
    await service.runForUser(userA, END_1);

    const result = await service.runForUser(userA, END_2);
    expect(result).toMatchObject({ detectionsEmitted: 1, patternsRedetected: 1, patternsStaled: 1 });
    expect(await statuses(userA)).toEqual({ [GAP_MEALS]: 'stale', [MOOD_ADHERENCE]: 'active' });
  });

  it('reactivates a stale pattern when a later run finds it again', async () => {
    await seed(userA, MARCH, 30, { gap: 'related', mood: 'related' });
    await seed(userA, addLocalDays(END_1, 1), 30, { gap: 'flat', mood: 'related' });
    await service.runForUser(userA, END_1);
    await service.runForUser(userA, END_2);
    const [stale] = await harness.sql`select id, first_detected_at from patterns where key = ${GAP_MEALS}`;

    // The second window's logs are corrected (rewritten summaries), and the day is run again.
    await seed(userA, addLocalDays(END_1, 1), 30, { gap: 'related', mood: 'related' });
    const result = await service.runForUser(userA, END_2);

    expect(result).toMatchObject({ patternsReactivated: 1, patternsRedetected: 1, patternsStaled: 0 });
    const [reactivated] = await harness.sql`select id, status, first_detected_at from patterns where key = ${GAP_MEALS}`;
    expect(reactivated).toEqual({ ...stale, status: 'active' });
  });

  it('never stales a dismissed pattern, and ignores it while its cooldown runs', async () => {
    await seed(userA, MARCH, 30, { gap: 'related', mood: 'related' });
    await seed(userA, addLocalDays(END_1, 1), 30, { gap: 'flat', mood: 'related' });
    await service.runForUser(userA, END_1);
    const gap = await patterns.findByUserAndKey(userA, GAP_MEALS);
    await patterns.dismiss(userA, gap!.id, NOW);

    const absent = await service.runForUser(userA, END_2);
    expect(absent.patternsStaled).toBe(0);
    expect((await statuses(userA))[GAP_MEALS]).toBe('dismissed');

    await seed(userA, addLocalDays(END_1, 1), 30, { gap: 'related', mood: 'related' });
    const present = await service.runForUser(userA, END_2);
    expect(present).toMatchObject({ detectionsSuppressed: 1, patternsReactivated: 0 });
    expect((await statuses(userA))[GAP_MEALS]).toBe('dismissed');
  });

  it('touches only the user it runs for', async () => {
    await seed(userB, MARCH, 30, { gap: 'related', mood: 'related' });
    await service.runForUser(userB, END_1);
    const bBefore = await harness.sql`select * from patterns where user_id = ${userB} order by key`;

    // User A's run finds nothing: B's active patterns must not be reconciled against it.
    await seed(userA, MARCH, 30, { gap: 'flat', mood: 'flat' });
    const result = await service.runForUser(userA, END_1);

    expect(result.patternsStaled).toBe(0);
    expect(await harness.sql`select * from patterns where user_id = ${userB} order by key`).toEqual(bBefore);
    expect(await statuses(userA)).toEqual({});
  });

  it('lets an older day neither overwrite nor retire what a newer day found', async () => {
    await seed(userA, MARCH, 60, { gap: 'related', mood: 'related' });
    await service.runForUser(userA, END_2);
    const before = await harness.sql`select * from patterns order by key`;

    const older = await service.runForUser(userA, END_1);
    expect(older).toMatchObject({ detectionsEmitted: 2, detectionsOutdated: 2, patternsStaled: 0 });
    expect(await harness.sql`select * from patterns order by key`).toEqual(before);
  });

  it('refuses the user local today without writing anything', async () => {
    await seed(userA, '2026-05-17', 30, { gap: 'related', mood: 'related' });
    await expect(service.runForUser(userA, '2026-06-15')).rejects.toBeInstanceOf(ValidationError);
    expect(await count()).toBe(0);
  });

  it('commits a run whole or not at all', async () => {
    await seed(userA, MARCH, 30, { gap: 'related', mood: 'related' });
    const failing = new PatternDetectionService({
      users: new UsersRepository(harness.database.db),
      summaries,
      patterns: {
        withUserLock: (userId, work) =>
          patterns.withUserLock(userId, (repository) =>
            work(
              Object.assign(Object.create(repository) as PatternsRepository, {
                // Detections are recorded, then reconciliation fails.
                listActive: async () => {
                  throw new Error('reconciliation read failed');
                },
              }),
            ),
          ),
      },
      logger: { info: () => {}, error: () => {} },
      now: () => NOW,
    });

    await expect(failing.runForUser(userA, END_1)).rejects.toThrow('reconciliation read failed');
    expect(await count()).toBe(0);
  });
});
