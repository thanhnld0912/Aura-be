import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLocalDays, startOfLocalWeek, todayIn } from '../../src/lib/local-date.js';
import { PatternDetectionService } from '../../src/modules/patterns/pattern-detection.service.js';
import { PatternsRepository } from '../../src/modules/patterns/patterns.repository.js';
import { DailySummariesRepository } from '../../src/modules/summaries/daily-summaries.repository.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * The pattern consumer as a deployment would run it — wired from `PATTERN_ENGINE_ENABLED`, no
 * source injected — against PostgreSQL and through `GET /api/insights/weekly` and
 * `POST /api/insights/weekly/story`:
 *
 * - off (the default) serves nothing, whatever the tables hold;
 * - on, a user no run has reached is "unavailable", never "none";
 * - on, evidence is served only while the evaluation behind it is current.
 *
 * The patterns are written by the real `PatternDetectionService`; nothing here starts a
 * scheduler. The API reads the real clock, so every date is relative to the real today.
 */
describe.skipIf(!hasDatabase)('pattern consumer — activation, evaluation state and freshness', () => {
  let enabled: DatabaseHarness;
  let disabled: DatabaseHarness;
  let patterns: PatternsRepository;
  let summaries: DailySummariesRepository;
  let tokenA: string;
  let tokenB: string;

  const userA = testUserId('a');
  const userB = testUserId('b');
  const TIMEZONE = 'Asia/Ho_Chi_Minh';
  const today = todayIn(TIMEZONE);
  const lastClosed = addLocalDays(today, -1);
  const STREAK = 'streak:logged_days';
  const PATTERN_CODES = ['pattern_engine_unavailable', 'pattern_evaluation_pending', 'pattern_evaluation_stale'];

  const detection = () =>
    new PatternDetectionService({
      users: new UsersRepository(enabled.database.db),
      summaries,
      patterns,
      logger: { info: () => {}, error: () => {} },
    });

  const logDays = async (userId: string, from: string, days: number) => {
    for (let i = 0; i < days; i++) {
      await summaries.upsert(userId, addLocalDays(from, i), {
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
    }
  };

  /** 45 logged days ending on `end`, then an authoritative run for `runDay`. */
  const evaluate = async (userId: string, runDay: string, loggedThrough = runDay) => {
    await logDays(userId, addLocalDays(loggedThrough, -44), 45);
    return detection().runForUser(userId, runDay);
  };

  const weekly = async (harness: DatabaseHarness, token: string) => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/insights/weekly', headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  const story = async (harness: DatabaseHarness, token: string) => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/insights/weekly/story',
      headers: bearer(token),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  const patternLimitations = (body: { dataQuality: { limitations: string[] } }) =>
    body.dataQuality.limitations.filter((code) => PATTERN_CODES.includes(code));

  const UNAVAILABLE = { status: 'unavailable', items: [] };
  const NONE = { status: 'none', items: [] };

  beforeAll(async () => {
    // No pattern source is injected into either app: each is wired from its environment alone.
    enabled = await createDatabaseHarness({ env: { PATTERN_ENGINE_ENABLED: 'true' } });
    disabled = await createDatabaseHarness();
    patterns = new PatternsRepository(enabled.database.db);
    summaries = new DailySummariesRepository(enabled.database.db);
    tokenA = await signTestToken({ sub: userA, email: 'a@example.com' });
    tokenB = await signTestToken({ sub: userB, email: 'b@example.com' });
  });

  afterAll(async () => {
    await enabled?.close();
    await disabled?.close();
  });

  beforeEach(async () => {
    await enabled.reset();
    for (const token of [tokenA, tokenB]) {
      await enabled.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
  });

  describe('off by default', () => {
    it('serves nothing, even with a fresh evaluation and an active pattern in the tables', async () => {
      await evaluate(userA, lastClosed);
      expect((await patterns.currentState(userA)).active.map((row) => row.key)).toEqual([STREAK]);

      const body = await weekly(disabled, tokenA);
      expect(body.patterns).toEqual(UNAVAILABLE);
      expect(body.patternFacts).toEqual(UNAVAILABLE);
      expect(patternLimitations(body)).toEqual(['pattern_engine_unavailable']);

      // The same tables, read by the app that was switched on.
      expect((await weekly(enabled, tokenA)).patternFacts.status).toBe('available');
    });

    it('is not switched on by the scheduler flag', async () => {
      const schedulerOnly = await createDatabaseHarness({ env: { CRON_ENABLED: 'true' } });
      try {
        await evaluate(userA, lastClosed);
        expect((await weekly(schedulerOnly, tokenA)).patternFacts).toEqual(UNAVAILABLE);
        // Building the API with the scheduler flag set ran nothing: the only watermark is the
        // one this test wrote.
        const [row] = await enabled.sql`select count(*)::int as n from pattern_watermarks`;
        expect(row!['n']).toBe(1);
      } finally {
        await schedulerOnly.close();
      }
    });
  });

  describe('never evaluated', () => {
    it('says unavailable — not none — for a user no run has reached', async () => {
      const body = await weekly(enabled, tokenA);
      expect(body.patterns).toEqual(UNAVAILABLE);
      expect(body.patternFacts).toEqual(UNAVAILABLE);
      expect(patternLimitations(body)).toEqual(['pattern_evaluation_pending']);
    });

    it('does not take pattern rows without a watermark for an evaluation', async () => {
      await evaluate(userA, lastClosed);
      await enabled.sql`delete from pattern_watermarks where user_id = ${userA}`;

      const body = await weekly(enabled, tokenA);
      expect(body.patternFacts).toEqual(UNAVAILABLE);
      expect(patternLimitations(body)).toEqual(['pattern_evaluation_pending']);
    });

    it('says none once a run has looked and found nothing', async () => {
      // Nothing logged: the run completes, writes the watermark and no pattern.
      await detection().runForUser(userA, lastClosed);

      const body = await weekly(enabled, tokenA);
      expect(body.patterns).toEqual(NONE);
      expect(body.patternFacts).toEqual(NONE);
      expect(patternLimitations(body)).toEqual([]);
    });
  });

  describe('freshness', () => {
    it('serves an ongoing streak from an evaluation of the last closed day', async () => {
      await evaluate(userA, lastClosed);

      const body = await weekly(enabled, tokenA);
      expect(body.patternFacts.status).toBe('available');
      expect(body.patternFacts.items[0]).toMatchObject({
        key: STREAK,
        current: true,
        windowEnd: lastClosed,
        run: { to: lastClosed, length: 45 },
      });
      expect(patternLimitations(body)).toEqual([]);
    });

    it('serves an ended streak as ended', async () => {
      // Logged through the day before; the last closed day itself has no log.
      await evaluate(userA, lastClosed, addLocalDays(lastClosed, -1));

      const [fact] = (await weekly(enabled, tokenA)).patternFacts.items;
      expect(fact).toMatchObject({
        current: false,
        windowEnd: lastClosed,
        run: { to: addLocalDays(lastClosed, -1), length: 44 },
      });
    });

    it('still serves when last night’s run has not reached the user — and dates the evidence', async () => {
      const through = addLocalDays(lastClosed, -1);
      await evaluate(userA, through);

      const body = await weekly(enabled, tokenA);
      expect(body.patternFacts.status).toBe('available');
      // `current` is relative to the evidence's own window, which the response carries.
      expect(body.patternFacts.items[0]).toMatchObject({ current: true, windowEnd: through, run: { to: through } });
    });

    it('withholds a streak once a nightly run was missed, without touching its lifecycle', async () => {
      const through = addLocalDays(lastClosed, -2);
      await evaluate(userA, through);

      const body = await weekly(enabled, tokenA);
      expect(body.patterns).toEqual(UNAVAILABLE);
      expect(body.patternFacts).toEqual(UNAVAILABLE);
      expect(patternLimitations(body)).toEqual(['pattern_evaluation_stale']);

      // Serving decided nothing about the row: it is still active, and the watermark has not moved.
      const state = await patterns.currentState(userA);
      expect(state.evaluatedThrough).toBe(through);
      expect(state.active.map((row) => row.status)).toEqual(['active']);
    });

    it('serves again once a later run catches up', async () => {
      await evaluate(userA, addLocalDays(lastClosed, -5));
      expect((await weekly(enabled, tokenA)).patternFacts).toEqual(UNAVAILABLE);

      await evaluate(userA, lastClosed);
      expect((await weekly(enabled, tokenA)).patternFacts.status).toBe('available');
    });

    it('refuses a watermark that names a day not closed yet', async () => {
      await evaluate(userA, lastClosed);
      await enabled.sql`update pattern_watermarks set evaluated_through = ${addLocalDays(today, 3)} where user_id = ${userA}`;

      const body = await weekly(enabled, tokenA);
      expect(body.patternFacts).toEqual(UNAVAILABLE);
      expect(patternLimitations(body)).toEqual(['pattern_engine_unavailable']);
    });

    it('leaves out an active row whose evidence the latest run did not produce', async () => {
      await evaluate(userA, lastClosed);
      const old = addLocalDays(lastClosed, -10);
      await enabled.sql`
        update patterns set window_end = ${old}, window_start = ${addLocalDays(old, -44)},
               evidence = jsonb_set(jsonb_set(evidence, '{run,to}', to_jsonb(${old}::text)),
                                    '{run,from}', to_jsonb(${addLocalDays(old, -44)}::text))
        where user_id = ${userA}`;

      // The evaluation is current and stands behind no row: that is "none", not a stale claim.
      expect((await weekly(enabled, tokenA)).patternFacts).toEqual(NONE);
    });

    it('applies one policy to ranked patterns and facts, in the report and in the story’s report', async () => {
      for (const [runDay, expected] of [
        [lastClosed, 'served'],
        [addLocalDays(lastClosed, -3), 'withheld'],
      ] as const) {
        await enabled.reset();
        await enabled.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(tokenA) });
        await evaluate(userA, runDay);

        const report = await weekly(enabled, tokenA);
        const told = await story(enabled, tokenA);
        expect(told.story).toBeNull();
        expect(told.report.patterns).toEqual(report.patterns);
        expect(told.report.patternFacts).toEqual(report.patternFacts);
        expect(patternLimitations(told.report)).toEqual(patternLimitations(report));

        if (expected === 'served') {
          // A streak is a fact: served beside the ranked list, never inside it.
          expect(report.patterns).toEqual(NONE);
          expect(report.patternFacts.status).toBe('available');
        } else {
          expect(report.patterns).toEqual(UNAVAILABLE);
          expect(report.patternFacts).toEqual(UNAVAILABLE);
        }
      }
    });

    it('cannot say what a past week held', async () => {
      await evaluate(userA, lastClosed);
      const lastWeek = addLocalDays(startOfLocalWeek(today), -7);
      const response = await enabled.app.inject({
        method: 'GET',
        url: `/api/insights/weekly?weekStart=${lastWeek}`,
        headers: bearer(tokenA),
      });
      const body = response.json();
      expect(body.patternFacts).toEqual(UNAVAILABLE);
      expect(patternLimitations(body)).toEqual(['pattern_engine_unavailable']);
    });
  });

  describe('when the pattern read fails', () => {
    it('returns the week with patterns unavailable — a 200, never a 500 and never none', async () => {
      let reads = 0;
      const failing = await createDatabaseHarness({
        patternEvidence: {
          async forPeriod() {
            reads += 1;
            throw new Error('canceling statement due to statement timeout');
          },
        },
      });
      try {
        // A current evaluation with a streak is in the tables; the read of it is what fails.
        await evaluate(userA, lastClosed);

        const body = await weekly(failing, tokenA);
        expect(body.patterns).toEqual(UNAVAILABLE);
        expect(body.patternFacts).toEqual(UNAVAILABLE);
        expect(patternLimitations(body)).toEqual(['pattern_engine_unavailable']);
        // The rest of the report is the week's own, and is intact.
        expect(body.period.weekStart).toBe(startOfLocalWeek(today));
        expect(body.days).toHaveLength(7);

        const told = await story(failing, tokenA);
        expect(told.report.patternFacts).toEqual(UNAVAILABLE);
        expect(reads).toBe(2);

        // The failure changed nothing that is stored.
        const state = await patterns.currentState(userA);
        expect(state.evaluatedThrough).toBe(lastClosed);
        expect(state.active.map((row) => row.key)).toEqual([STREAK]);
      } finally {
        await failing.close();
      }
    });
  });

  describe('ownership', () => {
    it('serves each user only their own evaluation state and patterns', async () => {
      await evaluate(userA, lastClosed);

      // B has no evaluation: A's watermark and A's streak say nothing about B.
      const before = await weekly(enabled, tokenB);
      expect(before.patternFacts).toEqual(UNAVAILABLE);
      expect(patternLimitations(before)).toEqual(['pattern_evaluation_pending']);

      // B evaluated with nothing logged: "none", and still nothing of A's.
      await detection().runForUser(userB, lastClosed);
      expect((await weekly(enabled, tokenB)).patternFacts).toEqual(NONE);

      const aBody = await weekly(enabled, tokenA);
      expect(aBody.patternFacts.items).toHaveLength(1);
      const [mine] = await enabled.sql`select id from patterns where user_id = ${userA}`;
      expect(aBody.patternFacts.items[0].id).toBe(mine!['id']);
    });

    it('still requires a token', async () => {
      const response = await enabled.app.inject({ method: 'GET', url: '/api/insights/weekly' });
      expect(response.statusCode).toBe(401);
    });
  });
});
