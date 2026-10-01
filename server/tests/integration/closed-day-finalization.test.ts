import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobLogger } from '../../src/jobs/nightly-pattern-detection.js';
import { createClosedDayPipeline, type ClosedDayPipeline } from '../../src/jobs/pattern-scheduler.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * Closed-day finalisation on real logs written through the API, with the production wiring
 * (`createClosedDayPipeline`) on a fixed clock: the day is reconciled and its summary
 * recomputed before detection reads it.
 *
 * To reproduce a day as it was left while still open, a test puts its plan items back to
 * `pending` and its summary back to the adherence it had then — exactly the state the
 * nightly finalisation exists to correct.
 */
describe.skipIf(!hasDatabase)('closed-day finalisation', () => {
  let harness: DatabaseHarness;
  let pipeline: ClosedDayPipeline;
  let tokenA: string;
  const detectionLog: Array<{ targetDate: string }> = [];
  const failures: object[] = [];

  const userA = testUserId('a');
  // 05:00 UTC on 5 April is 12:00 in Ho Chi Minh City: every March day is closed.
  const NOW = new Date('2026-04-05T05:00:00Z');

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

  const adherence = async (userId: string, localDate: string) =>
    (await harness.sql`select plan_adherence_pct::text as p from daily_summaries where user_id = ${userId} and local_date = ${localDate}`)[0]?.['p'];
  const itemStates = async (userId: string, localDate: string) =>
    (
      await harness.sql`
        select pi.adherence from plan_items pi join daily_plans dp on dp.id = pi.plan_id
        where dp.user_id = ${userId} and dp.local_date = ${localDate} order by pi.sort_order`
    ).map((r) => r['adherence']);

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    const logger: JobLogger = {
      info: (context, message) => {
        if (message === 'pattern detection run complete') detectionLog.push(context as { targetDate: string });
      },
      error: (context) => failures.push(context),
    };
    pipeline = createClosedDayPipeline(harness.database, logger, () => NOW);
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
  });

  // Each test writes a day through the API and runs finalisation and detection, sometimes twice:
  // well under a second normally, but several on a loaded machine, so more room than five seconds.
  describe('finalising a closed day', { timeout: 30_000 }, () => {
    const DAY = '2026-03-10';

    it('turns pending items into not_logged and recomputes the summary by the existing rules', async () => {
      await logDay(DAY, 'good', 1);
      await reopen(userA, DAY);
      expect(await itemStates(userA, DAY)).toEqual(['on_time', 'pending']);
      expect(await adherence(userA, DAY)).toBe('100.00'); // pending is not counted while open

      await pipeline.processor.process(userA, DAY);

      expect(await itemStates(userA, DAY)).toEqual(['on_time', 'not_logged']);
      expect(await adherence(userA, DAY)).toBe('50.00'); // happened / resolved, with not_logged resolved
      // …and detection ran on the day, after it (the order itself: tests/unit/closed-day-processing.test.ts).
      expect(detectionLog.map((entry) => entry.targetDate)).toEqual([DAY]);
      expect(failures).toEqual([]);
    });

    it('is idempotent: finalising twice writes the same day and counts nothing twice', async () => {
      await logDay(DAY, 'good', 1);
      await reopen(userA, DAY);
      await pipeline.processor.process(userA, DAY);
      const snapshot = async () => ({
        summary: await harness.sql`
          select events_logged, meals_logged, plan_adherence_pct, mood, metrics
          from daily_summaries where user_id = ${userA}`,
        items: await harness.sql`select adherence, linked_event_id from plan_items order by sort_order`,
        events: (await harness.sql`select count(*)::int as c from daily_events`)[0]?.['c'],
      });
      const once = await snapshot();

      await pipeline.processor.process(userA, DAY);

      expect(await snapshot()).toEqual(once);
    });

    it('refuses the user local today', async () => {
      await expect(pipeline.processor.process(userA, '2026-04-05')).rejects.toMatchObject({
        details: [{ path: 'targetDate', issue: 'day_not_closed' }],
      });
    });
  });
});
