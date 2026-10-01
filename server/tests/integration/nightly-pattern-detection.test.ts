import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NightlyPatternDetection, type JobLogger } from '../../src/jobs/nightly-pattern-detection.js';
import { addLocalDays } from '../../src/lib/local-date.js';
import { PatternDetectionService } from '../../src/modules/patterns/pattern-detection.service.js';
import { PatternsRepository } from '../../src/modules/patterns/patterns.repository.js';
import { DailySummariesRepository } from '../../src/modules/summaries/daily-summaries.repository.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * The nightly job against PostgreSQL, with the real `PatternDetectionService`: each active
 * user is processed for the day that is closed in **their** timezone, one user's failure
 * does not stop the others, and a second run of the same night changes nothing.
 */
describe.skipIf(!hasDatabase)('nightly pattern detection', () => {
  let harness: DatabaseHarness;
  let summaries: DailySummariesRepository;
  let job: NightlyPatternDetection;
  const failures: object[] = [];

  const vietnam = testUserId('a'); // Asia/Ho_Chi_Minh, UTC+7
  const newYork = testUserId('b'); // America/New_York, UTC−4 in October
  const third = '00000000-0000-4000-8000-00000000000c';

  // 19:15 UTC on 1 October: 02:15 on 2 October in Ho Chi Minh City, 15:15 on 1 October in New York.
  const NOW = new Date('2026-10-01T19:15:00Z');
  const VIETNAM_DAY = '2026-10-01';
  const NEW_YORK_DAY = '2026-09-30';
  const MOODS = ['low', 'okay', 'good', 'great'] as const;

  /** Thirty days ending `end` on which mood and plan adherence move together. */
  async function seedRelated(userId: string, end: string) {
    for (let i = 0; i < 30; i++) {
      const mood = (i % 4) + 1;
      await summaries.upsert(userId, addLocalDays(end, i - 29), {
        eventsLogged: 3,
        mealsLogged: 2,
        waterMl: null,
        distinctFoods: null,
        vegetableServings: null,
        proteinServings: null,
        sleepMinutes: null,
        firstMealTime: null,
        lastMealTime: null,
        bedtime: null,
        planAdherencePct: String(mood * 20 + (i % 3) * 5),
        mood: MOODS[mood - 1]!,
        metrics: {},
      });
    }
  }

  const patternsOf = async (userId: string) =>
    harness.sql`select key, status, window_end::text as window_end from patterns where user_id = ${userId} order by key`;

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    const db = harness.database.db;
    summaries = new DailySummariesRepository(db);
    const users = new UsersRepository(db);
    const logger: JobLogger = { info: () => {}, error: (context) => failures.push(context) };
    const detection = new PatternDetectionService({
      users,
      summaries,
      patterns: new PatternsRepository(db),
      logger,
      now: () => NOW,
    });
    job = new NightlyPatternDetection({ users, detection, logger, pageSize: 2 });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    failures.length = 0;
    for (const [sub, email] of [
      [vietnam, 'vn@example.com'],
      [newYork, 'ny@example.com'],
      [third, 'third@example.com'],
    ] as const) {
      const token = await signTestToken({ sub, email });
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
    await harness.sql`update users set timezone = 'America/New_York' where id = ${newYork}`;
  });

  it('processes each user for the day closed in their own timezone', async () => {
    await seedRelated(vietnam, VIETNAM_DAY);
    await seedRelated(newYork, NEW_YORK_DAY);

    const result = await job.run(NOW);

    expect(result).toMatchObject({ targetedUsers: 3, succeededUsers: 3, failedUsers: 0, skippedUsers: 0 });
    expect(await patternsOf(vietnam)).toEqual([
      { key: 'correlation:mood_score:plan_adherence_pct', status: 'active', window_end: VIETNAM_DAY },
    ]);
    expect(await patternsOf(newYork)).toEqual([
      { key: 'correlation:mood_score:plan_adherence_pct', status: 'active', window_end: NEW_YORK_DAY },
    ]);
    // The third user logged nothing: a successful run with nothing found.
    expect(await patternsOf(third)).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('leaves the same patterns when the same night runs twice', async () => {
    await seedRelated(vietnam, VIETNAM_DAY);
    await job.run(NOW);
    const before = await harness.sql`select * from patterns order by user_id, key`;

    const again = await job.run(NOW);
    expect(again).toMatchObject({ succeededUsers: 3, failedUsers: 0 });
    const after = await harness.sql`select * from patterns order by user_id, key`;
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => [r['id'], r['first_detected_at'], r['status']])).toEqual(
      before.map((r) => [r['id'], r['first_detected_at'], r['status']]),
    );
  });

  it('isolates a failing user: the others are processed and keep their own patterns', async () => {
    await seedRelated(vietnam, VIETNAM_DAY);
    await seedRelated(newYork, NEW_YORK_DAY);
    // A timezone the database holds but no clock can read — written behind the API's validation.
    await harness.sql`update users set timezone = 'Not/AZone' where id = ${third}`;

    const result = await job.run(NOW);

    expect(result).toMatchObject({ targetedUsers: 3, succeededUsers: 2, failedUsers: 1 });
    expect(failures).toEqual([expect.objectContaining({ userId: third, err: expect.objectContaining({ name: 'RangeError' }) })]);
    expect((await patternsOf(vietnam)).map((r) => r['status'])).toEqual(['active']);
    expect((await patternsOf(newYork)).map((r) => r['status'])).toEqual(['active']);
  });

  it('does not target a soft-deleted user', async () => {
    await seedRelated(newYork, NEW_YORK_DAY);
    await harness.sql`update users set deleted_at = now() where id = ${newYork}`;

    const result = await job.run(NOW);

    expect(result).toMatchObject({ targetedUsers: 2, succeededUsers: 2 });
    expect(await patternsOf(newYork)).toEqual([]);
  });
});
