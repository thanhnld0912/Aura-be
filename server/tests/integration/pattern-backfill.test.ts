import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobLogger } from '../../src/jobs/nightly-pattern-detection.js';
import { PatternBackfill } from '../../src/jobs/pattern-backfill.js';
import { createClosedDayPipeline, type ClosedDayPipeline } from '../../src/jobs/pattern-scheduler.js';
import { addLocalDays } from '../../src/lib/local-date.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * The backfill on real logs written through the API, with the production wiring
 * (`createClosedDayPipeline`) on a fixed clock.
 *
 * To reproduce a day as it was left while still open, a test puts its plan items back to
 * `pending` and its summary back to the adherence it had then — exactly the state the
 * nightly finalisation exists to correct.
 */
describe.skipIf(!hasDatabase)('pattern backfill', () => {
  let harness: DatabaseHarness;
  let pipeline: ClosedDayPipeline;
  let backfill: PatternBackfill;
  let tokenA: string;
  const detectionLog: Array<{ targetDate: string }> = [];
  const failures: object[] = [];

  const userA = testUserId('a');
  const userB = testUserId('b');
  // 05:00 UTC on 5 April is 12:00 in Ho Chi Minh City: every March day is closed.
  const NOW = new Date('2026-04-05T05:00:00Z');
  const FIRST = '2026-03-01';
  const MOOD_ADHERENCE = 'correlation:mood_score:plan_adherence_pct';

  const utcAt = (localDate: string, localTime: string): string => {
    const [y, mo, d] = localDate.split('-').map(Number) as [number, number, number];
    const [h, mi] = localTime.split(':').map(Number) as [number, number];
    return new Date(Date.UTC(y, mo - 1, d, h - 7, mi)).toISOString();
  };

  const post = async (token: string, url: string, payload: Record<string, unknown>) => {
    const response = await harness.app.inject({ method: 'POST', url, headers: bearer(token), payload });
    expect(response.statusCode, `${url} ${response.body}`).toBeLessThan(300);
  };

  /** A two-item plan, `done` of its items logged, and the day's check-in. */
  const logDay = async (localDate: string, mood: 'low' | 'okay' | 'good' | 'great', done: 0 | 1 | 2) => {
    await post(tokenA, '/api/daily-plan', {
      localDate,
      items: [
        { eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' },
        { eventType: 'water', title: 'Drink water', plannedTime: '10:00' },
      ],
    });
    if (done >= 1) await post(tokenA, '/api/events', { type: 'walk', title: 'Walked', occurredAt: utcAt(localDate, '07:05') });
    if (done >= 2) await post(tokenA, '/api/events', { type: 'water', title: 'Water', occurredAt: utcAt(localDate, '10:05') });
    await post(tokenA, '/api/checkins', { localDate, mood });
  };

  /**
   * Puts a closed day back to how it stood while open: unmatched items `pending`, and the
   * summary's adherence computed from the matched items alone, as it was then.
   */
  const reopen = async (userId: string, localDate: string) => {
    await harness.sql`
      update plan_items set adherence = 'pending'
      where adherence = 'not_logged'
        and plan_id in (select id from daily_plans where user_id = ${userId} and local_date = ${localDate})`;
    await harness.sql`
      update daily_summaries
      set plan_adherence_pct = case when exists (
            select 1 from plan_items pi join daily_plans dp on dp.id = pi.plan_id
            where dp.user_id = ${userId} and dp.local_date = ${localDate} and pi.linked_event_id is not null)
          then 100.00 else null end
      where user_id = ${userId} and local_date = ${localDate}`;
  };

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    const logger: JobLogger = {
      info: (context, message) => {
        if (message === 'pattern detection run complete') detectionLog.push(context as { targetDate: string });
      },
      error: (context) => failures.push(context),
    };
    pipeline = createClosedDayPipeline(harness.database, logger, () => NOW);
    backfill = new PatternBackfill({ users: pipeline.users, processor: pipeline.processor, logger });
    tokenA = await signTestToken({ sub: userA, email: 'a@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    detectionLog.length = 0;
    failures.length = 0;
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(tokenA) });
    const tokenB = await signTestToken({ sub: userB, email: 'b@example.com' });
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(tokenB) });
  });

  // Each test writes a month of logs through the API and backfills it, once or twice: slow by
  // design, so these get room beyond the default five seconds.
  describe('backfill', { timeout: 60_000 }, () => {
    /** Twenty-four logged days from 1 March: the better the mood, the more of the plan happened. */
    const logMonth = async () => {
      const cycle: Array<['low' | 'okay' | 'good' | 'great', 0 | 1 | 2]> = [
        ['low', 0],
        ['okay', 1],
        ['good', 1],
        ['great', 2],
      ];
      for (let i = 0; i < 24; i++) {
        const [mood, done] = cycle[i % 4]!;
        await logDay(addLocalDays(FIRST, i), mood, done);
      }
    };
    const LAST = addLocalDays(FIRST, 23); // 24 March

    it('finalises and detects every day oldest first, and detection reads the finalised days', async () => {
      await logMonth();
      for (let i = 0; i < 24; i++) await reopen(userA, addLocalDays(FIRST, i));

      const result = await backfill.run({ from: FIRST, to: LAST, userIds: [userA] }, NOW);

      expect(result).toMatchObject({ users: 1, daysProcessed: 24, daysFailed: 0, daysHistorical: 0, failures: [] });
      expect(detectionLog.map((entry) => entry.targetDate)).toEqual(
        Array.from({ length: 24 }, (_, i) => addLocalDays(FIRST, i)),
      );

      const [pattern] = await harness.sql`
        select status, window_end::text as window_end, evidence from patterns where user_id = ${userA} and key = ${MOOD_ADHERENCE}`;
      expect(pattern).toMatchObject({ status: 'active', window_end: LAST });
      // Every point carries the finalised adherence: 0, 50, 50, 100 — never the open-day 100 or null.
      const points = (pattern!['evidence'] as { points: Array<{ localDate: string; subject: number; object: number }> }).points;
      expect(points).toHaveLength(24);
      for (const [i, point] of points.entries()) expect(point.object).toBe([0, 50, 50, 100][i % 4]);
    });

    it('converges: the same backfill again leaves the same patterns', async () => {
      await logMonth();
      await backfill.run({ from: FIRST, to: LAST, userIds: [userA] }, NOW);
      const before = await harness.sql`select id, key, status, first_detected_at, window_end from patterns order by key`;

      const again = await backfill.run({ from: FIRST, to: LAST, userIds: [userA] }, NOW);

      // Every day but the last is before the watermark the first run left.
      expect(again).toMatchObject({ daysProcessed: 24, daysHistorical: 23, daysFailed: 0 });
      expect(await harness.sql`select id, key, status, first_detected_at, window_end from patterns order by key`).toEqual(before);
    });

    it('never touches another user', async () => {
      await harness.sql`
        insert into patterns (user_id, key, kind, subject_metric, object_metric, direction, strength, p_value,
          sample_size, coverage, window_start, window_end, window_days, evidence, detector_version,
          first_detected_at, last_detected_at, status_changed_at)
        values (${userB}, ${MOOD_ADHERENCE}, 'correlation', 'mood_score', 'plan_adherence_pct', 'positive',
          0.7, 0.01, 20, 0.8, '2026-02-01', '2026-03-02', 30, '{"points":[]}', 'correlation@1', now(), now(), now())`;
      const bBefore = await harness.sql`select * from patterns where user_id = ${userB}`;
      await logMonth();

      await backfill.run({ from: FIRST, to: LAST, userIds: [userA] }, NOW);

      expect(await harness.sql`select * from patterns where user_id = ${userB}`).toEqual(bBefore);
      expect(await harness.sql`select * from pattern_watermarks where user_id = ${userB}`).toEqual([]);
    });

    it('skips the days that are not closed, without failing', async () => {
      const result = await backfill.run({ from: '2026-04-03', to: '2026-04-07', userIds: [userA] }, NOW);
      expect(result).toMatchObject({ daysProcessed: 2, daysSkipped: 3, daysFailed: 0 });
      expect(detectionLog.map((entry) => entry.targetDate)).toEqual(['2026-04-03', '2026-04-04']);
    });
  });
});
