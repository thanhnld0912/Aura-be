import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PatternEvidenceSource } from '../../src/insights/pattern-evidence.js';
import { addLocalDays, startOfLocalWeek, todayIn } from '../../src/lib/local-date.js';
import { PatternDetectionService, type DetectionLogger } from '../../src/modules/patterns/pattern-detection.service.js';
import { PatternsEvidenceSource } from '../../src/modules/patterns/patterns-evidence-source.js';
import { PatternsRepository } from '../../src/modules/patterns/patterns.repository.js';
import { DailySummariesRepository } from '../../src/modules/summaries/daily-summaries.repository.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * The logging streak end to end against PostgreSQL (PATTERN_ENGINE_DECISIONS.md D6, D10 S1/S3,
 * D16, D17): day summaries in, one `streak:logged_days` row persisted through the same
 * lifecycle and watermark as every pattern, and served as a fact beside — never inside — the
 * ranked list of `GET /api/insights/weekly`.
 */
describe.skipIf(!hasDatabase)('logging streak — persisted and served', () => {
  let harness: DatabaseHarness;
  let patterns: PatternsRepository;
  let summaries: DailySummariesRepository;
  let source: PatternsEvidenceSource;
  const logs: { info: object[]; error: object[] } = { info: [], error: [] };
  const logger: DetectionLogger = { info: (c) => logs.info.push(c), error: (c) => logs.error.push(c) };

  const userA = testUserId('a');
  const userB = testUserId('b');
  let tokenA: string;
  let tokenB: string;

  // 05:00 UTC is 12:00 in Ho Chi Minh City: the users' today is 25 July 2026, so every day
  // these scenarios run on is closed.
  const NOW = new Date('2026-07-25T05:00:00Z');
  const END = '2026-05-31';
  const START = addLocalDays(END, -44); // the 45-day window ending on END
  const STREAK = 'streak:logged_days';
  const GAP_MEALS = 'correlation:logging_gap_hours:meals_logged';

  const service = (now: Date = NOW, detect?: ConstructorParameters<typeof PatternDetectionService>[0]['detect']) =>
    new PatternDetectionService({
      users: new UsersRepository(harness.database.db),
      summaries,
      patterns,
      logger,
      now: () => now,
      ...(detect ? { detect } : {}),
    });

  /** A day on which something was logged, and nothing a correlation could use. */
  const logDay = (userId: string, localDate: string) =>
    summaries.upsert(userId, localDate, {
      eventsLogged: 1,
      mealsLogged: 0,
      waterMl: null,
      distinctFoods: null,
      vegetableServings: null,
      proteinServings: null,
      sleepMinutes: null,
      firstMealTime: null,
      lastMealTime: null,
      bedtime: null,
      planAdherencePct: null,
      mood: null,
      metrics: {},
    });

  const logDays = async (userId: string, from: string, days: number) => {
    for (let i = 0; i < days; i++) await logDay(userId, addLocalDays(from, i));
  };

  const streakRow = async (userId: string) =>
    (
      await harness.sql`
        select id, kind::text, subject_metric, object_metric, direction::text, strength, p_value, sample_size,
               coverage, window_start::text, window_end::text, window_days, evidence, detector_version,
               status::text, first_detected_at, last_detected_at, status_changed_at
        from patterns where user_id = ${userId} and key = ${STREAK}`
    )[0];

  beforeAll(async () => {
    const lazySource: PatternEvidenceSource = { forPeriod: (userId, request) => source.forPeriod(userId, request) };
    harness = await createDatabaseHarness({ patternEvidence: lazySource });
    patterns = new PatternsRepository(harness.database.db);
    summaries = new DailySummariesRepository(harness.database.db);
    source = new PatternsEvidenceSource(patterns);
    tokenA = await signTestToken({ sub: userA, email: 'a@example.com' });
    tokenB = await signTestToken({ sub: userB, email: 'b@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    logs.info.length = 0;
    logs.error.length = 0;
    for (const token of [tokenA, tokenB]) {
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
  });

  it('persists the longest run as one streak row with the D6 mapping', async () => {
    // Oldest first: 10 logged, 2 empty, 22 logged, 1 empty, the last 10 logged (ending on END).
    await logDays(userA, START, 10);
    await logDays(userA, addLocalDays(START, 12), 22);
    await logDays(userA, addLocalDays(END, -9), 10);

    const run = await service().runForUser(userA, END);
    expect(run).toMatchObject({ patternsCreated: 1, historical: false });

    const row = await streakRow(userA);
    expect(row).toMatchObject({
      kind: 'streak',
      subject_metric: 'logged_day',
      object_metric: null,
      direction: 'none',
      p_value: null,
      sample_size: 22,
      window_start: START,
      window_end: END,
      window_days: 45,
      detector_version: 'frequency_streak@1',
      status: 'active',
    });
    expect(row!['strength']).toBeCloseTo(22 / 45, 12);
    expect(row!['coverage']).toBeCloseTo(42 / 45, 12);
    expect(row!['evidence']).toEqual({
      type: 'logged_days',
      run: { from: addLocalDays(START, 12), to: addLocalDays(START, 33), length: 22 },
      current: false,
      observedDays: 42,
      windowDays: 45,
    });
  });

  it('writes nothing below the D16 cold-start gate', async () => {
    await logDays(userA, addLocalDays(END, -28), 29); // 29 consecutive days: a run, but cold start
    expect(await service().runForUser(userA, END)).toMatchObject({ detectionsEmitted: 0, patternsCreated: 0 });
    expect(await streakRow(userA)).toBeUndefined();
  });

  it('is idempotent: the same day twice leaves one row, its id and first detection', async () => {
    await logDays(userA, START, 45);
    await service().runForUser(userA, END);
    const first = await streakRow(userA);
    const again = await service().runForUser(userA, END);
    const second = await streakRow(userA);

    expect(again).toMatchObject({ patternsCreated: 0, patternsRedetected: 1 });
    expect(second!['id']).toBe(first!['id']);
    expect(second!['first_detected_at']).toEqual(first!['first_detected_at']);
    expect(second!['evidence']).toEqual(first!['evidence']);
    expect((await harness.sql`select count(*)::int as c from patterns where user_id = ${userA}`)[0]!['c']).toBe(1);
  });

  it('goes stale when the gate stops holding, and is reactivated — never re-created — when it holds again', async () => {
    await logDays(userA, START, 45);
    await service().runForUser(userA, END);
    const created = await streakRow(userA);

    // 20 days with nothing logged: 25 observed days in the window ending then — cold start.
    const quiet = addLocalDays(END, 20);
    expect(await service().runForUser(userA, quiet)).toMatchObject({ patternsStaled: 1 });
    expect((await streakRow(userA))!['status']).toBe('stale');

    // Logging resumes for 30 days. Once the 20 empty days have partly left the window, 30 of
    // its 45 days are logged again — the gate holds, on a 30-day run.
    await logDays(userA, addLocalDays(quiet, 1), 30);
    const back = addLocalDays(quiet, 30);
    expect(await service().runForUser(userA, back)).toMatchObject({ patternsReactivated: 1 });

    const reactivated = await streakRow(userA);
    expect(reactivated).toMatchObject({ status: 'active', sample_size: 30 });
    expect(reactivated!['id']).toBe(created!['id']);
    expect(reactivated!['first_detected_at']).toEqual(created!['first_detected_at']);
  });

  it('a historical run before the watermark cannot reactivate a stale streak (D17)', async () => {
    await logDays(userA, START, 45);
    await service().runForUser(userA, END);
    await service().runForUser(userA, addLocalDays(END, 14)); // 31 observed: still active
    const staleDay = addLocalDays(END, 20);
    await service().runForUser(userA, staleDay);
    expect((await streakRow(userA))!['status']).toBe('stale');

    // END is before the watermark: the run detects the streak and writes nothing.
    const historical = await service().runForUser(userA, END);
    expect(historical).toMatchObject({ historical: true, patternsReactivated: 0, detectionsOutdated: 1 });
    expect((await streakRow(userA))!['status']).toBe('stale');
    const [watermark] = await harness.sql`select evaluated_through::text as d from pattern_watermarks where user_id = ${userA}`;
    expect(watermark!['d']).toBe(staleDay);
  });

  it('a failing detector stales nothing', async () => {
    await logDays(userA, START, 45);
    await service().runForUser(userA, END);
    const failing = service(NOW, () => {
      throw new Error('detector exploded');
    });
    await expect(failing.runForUser(userA, addLocalDays(END, 1))).rejects.toThrow('detector exploded');
    expect((await streakRow(userA))!['status']).toBe('active');
  });

  it('keeps one user’s streak to that user', async () => {
    await logDays(userA, START, 45);
    await logDays(userB, START, 12);
    await service().runForUser(userA, END);
    await service().runForUser(userB, END);
    expect(await streakRow(userA)).toBeDefined();
    expect(await streakRow(userB)).toBeUndefined();
    expect(await source.forPeriod(userB, { from: END, to: END, today: END })).toEqual([]);
  });

  it('leaves correlation rows, their evidence and their ranking as they were', async () => {
    // 30 related days: the gap/meals correlation emits, and 30 logged days make a streak too.
    const from = addLocalDays(END, -29);
    for (let i = 0; i < 30; i++) {
      const gap = 2 + (i % 12);
      await summaries.upsert(userA, addLocalDays(from, i), {
        eventsLogged: 4,
        mealsLogged: Math.max(0, 5 - Math.floor(gap / 3)),
        waterMl: null,
        distinctFoods: null,
        vegetableServings: null,
        proteinServings: null,
        sleepMinutes: null,
        firstMealTime: null,
        lastMealTime: null,
        bedtime: null,
        planAdherencePct: null,
        mood: null,
        metrics: { logging_gap_hours: gap },
      });
    }
    await service().runForUser(userA, END);

    const rows = await harness.sql`select key, kind::text, evidence from patterns where user_id = ${userA} order by key`;
    expect(rows.map((row) => row['key'])).toEqual([GAP_MEALS, STREAK]);
    const correlation = rows.find((row) => row['key'] === GAP_MEALS)!;
    expect(Object.keys(correlation['evidence'] as object)).toEqual(['points']);
    expect((correlation['evidence'] as { points: unknown[] }).points).toHaveLength(30);
  });

  describe('GET /api/insights/weekly', () => {
    // The API reads the real clock, so these days are placed relative to the real today.
    const today = todayIn('Asia/Ho_Chi_Minh');
    const lastClosed = addLocalDays(today, -1);
    const thisWeek = startOfLocalWeek(today);

    const weekly = async (token: string, weekStart?: string) => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/insights/weekly${weekStart ? `?weekStart=${weekStart}` : ''}`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };

    beforeEach(async () => {
      await logDays(userA, addLocalDays(lastClosed, -44), 45);
      await service(new Date()).runForUser(userA, lastClosed);
    });

    it('serves the streak as a fact with its label and caveat, outside the ranked patterns', async () => {
      const body = await weekly(tokenA);
      expect(body.patterns.items.map((item: { kind: string }) => item.kind)).not.toContain('streak');
      expect(body.patternFacts.status).toBe('available');
      expect(body.patternFacts.items).toEqual([
        expect.objectContaining({
          kind: 'streak',
          key: STREAK,
          subjectMetric: 'logged_day',
          subjectLabel: 'Logging consistency',
          strength: 1,
          sampleSize: 45,
          windowDays: 45,
          run: { from: addLocalDays(lastClosed, -44), to: lastClosed, length: 45 },
          current: true,
          observedDays: 45,
          caveat: 'This counts days you logged something, not what you did.',
        }),
      ]);
      expect(Object.keys(body.patternFacts.items[0])).not.toContain('pValue');
    });

    it('says unavailable for a past week rather than presenting today’s streak as history', async () => {
      const body = await weekly(tokenA, addLocalDays(thisWeek, -14));
      expect(body.patternFacts).toEqual({ status: 'unavailable', items: [] });
    });

    it('never shows one user another user’s streak', async () => {
      const body = await weekly(tokenB);
      expect(body.patternFacts).toEqual({ status: 'none', items: [] });
    });
  });
});
