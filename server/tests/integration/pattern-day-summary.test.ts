import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFoods } from '../../src/database/seeds/seed-foods.js';
import { DailySummariesRepository } from '../../src/modules/summaries/daily-summaries.repository.js';
import { coverage, seriesFor, windowEnding } from '../../src/patterns/coverage.js';
import { DAY_FACT_KEYS } from '../../src/patterns/day-facts.js';
import { extractDailyFeatures } from '../../src/patterns/metrics.js';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * The Pattern Engine's input, end to end: API writes → `daily_summaries` → metrics.
 *
 * What has to hold against a real PostgreSQL is the one rule the engine's honesty rests
 * on — nothing unmeasured is stored as 0 — plus the derived day facts, and the backfill
 * that rewrites rows written under the old zero defaults.
 */
describe.skipIf(!hasDatabase)('pattern engine input: daily summaries', () => {
  let harness: DatabaseHarness;
  let token: string;
  let summaries: DailySummariesRepository;
  const userId = testUserId('a');

  // Fixed and in the past, as in plan-actual.test.ts, so nothing depends on today.
  const DATE = '2026-03-04';

  /** Vietnam is UTC+7: a local wall-clock time on DATE, as an instant. */
  const utcFor = (localTime: string, day = 4): string => {
    const [h, m] = localTime.split(':').map(Number) as [number, number];
    return new Date(Date.UTC(2026, 2, day, h - 7, m)).toISOString();
  };

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    token = await signTestToken({ sub: userId, email: 'thanh@example.com' });
    summaries = new DailySummariesRepository(harness.database.db);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await seedFoods(harness.database.db);
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
  });

  const inject = (method: 'POST' | 'GET', url: string, payload?: Record<string, unknown>) =>
    harness.app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });

  const logEvent = async (payload: Record<string, unknown>) => {
    const response = await inject('POST', '/api/events', payload);
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  const summaryFor = async (localDate = DATE) => {
    const row = await summaries.findByDate(userId, localDate);
    if (!row) throw new Error(`no summary for ${localDate}`);
    return row;
  };

  const foodId = async (q: string): Promise<string> => {
    const response = await harness.app.inject({ method: 'GET', url: `/api/nutrition/search?q=${encodeURIComponent(q)}` });
    return response.json().data[0].foodId;
  };

  describe('water', () => {
    it('is null when no water event was logged', async () => {
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:00') });
      expect((await summaryFor()).waterMl).toBeNull();
    });

    it('is null when water was logged without an amount', async () => {
      await logEvent({ type: 'water', title: 'Water', occurredAt: utcFor('09:00') });
      expect((await summaryFor()).waterMl).toBeNull();
    });

    it('sums the amounts logged, and keeps a logged 0 as a measured 0', async () => {
      await logEvent({ type: 'water', title: 'Water', occurredAt: utcFor('09:00'), metrics: { ml: 250 } });
      await logEvent({ type: 'water', title: 'Water', occurredAt: utcFor('15:00'), metrics: { ml: 500 } });
      expect(Number((await summaryFor()).waterMl)).toBe(750);

      await harness.reset();
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
      await logEvent({ type: 'water', title: 'Water', occurredAt: utcFor('09:00'), metrics: { ml: 0 } });
      expect((await summaryFor()).waterMl).toBe('0.0');
    });
  });

  describe('meals', () => {
    it('derives distinct foods, meal times and breakfast from confirmed meals', async () => {
      const rice = await foodId('cơm trắng');
      const pho = await foodId('phở bò');
      const breakfast = await inject('POST', '/api/meals', {
        mealType: 'breakfast',
        occurredAt: utcFor('07:45'),
        items: [{ foodId: pho, quantity: 1, unit: 'bowl' }],
      });
      expect(breakfast.statusCode).toBe(201);
      await inject('POST', '/api/meals', {
        mealType: 'dinner',
        occurredAt: utcFor('19:30'),
        items: [
          { foodId: rice, quantity: 1, unit: 'bowl' },
          { foodId: pho, quantity: 1, unit: 'bowl' },
        ],
      });

      const row = await summaryFor();
      expect(row.mealsLogged).toBe(2);
      expect(row.distinctFoods).toBe(2);
      expect(row.vegetableServings).toBeNull();
      expect(row.proteinServings).toBeNull();

      const { values } = extractDailyFeatures(row);
      expect(values.first_meal_min).toBe(7 * 60 + 45);
      expect(values.last_meal_min).toBe(19 * 60 + 30);
      expect(values.breakfast_logged).toBe(1);
      expect(values.meals_logged).toBe(2);
      expect(values.distinct_foods).toBe(2);
    });

    it('leaves distinct foods unknown when no item resolved to a food', async () => {
      const response = await inject('POST', '/api/meals', {
        mealType: 'lunch',
        occurredAt: utcFor('12:00'),
        items: [{ name: 'món không có trong dữ liệu xyzq', quantity: 1, unit: 'serving' }],
      });
      expect(response.statusCode).toBe(201);

      const row = await summaryFor();
      expect(row.mealsLogged).toBe(1);
      expect(row.distinctFoods).toBeNull();
    });

    it('does not count a draft — not even as breakfast', async () => {
      const rice = await foodId('cơm trắng');
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:00') });
      await inject('POST', '/api/meals', {
        mealType: 'breakfast',
        status: 'draft',
        occurredAt: utcFor('07:30'),
        items: [{ foodId: rice, quantity: 1, unit: 'bowl' }],
      });
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('17:00') });

      const row = await summaryFor();
      expect(row.mealsLogged).toBe(0);
      expect(row.distinctFoods).toBeNull();
      // Observed day (two walks) with no confirmed meal: breakfast not logged (D2).
      expect(extractDailyFeatures(row).values.breakfast_logged).toBe(0);
    });
  });

  describe('breakfast_logged (decision D2)', () => {
    const breakfastOn = async (localDate = DATE) => extractDailyFeatures(await summaryFor(localDate)).values.breakfast_logged;

    const logMeal = async (mealType: string, localTime: string, day = 4) => {
      const response = await inject('POST', '/api/meals', {
        mealType,
        occurredAt: utcFor(localTime, day),
        items: [{ foodId: await foodId('phở bò'), quantity: 1, unit: 'bowl' }],
      });
      expect(response.statusCode).toBe(201);
      return response.json();
    };

    it('is 1 for a confirmed meal before 10:30', async () => {
      await logMeal('breakfast', '07:30');
      expect(await breakfastOn()).toBe(1);
    });

    it('is 0 on an observed day whose only meal is later', async () => {
      await logMeal('lunch', '12:00');
      expect(await breakfastOn()).toBe(0);
    });

    it('is 0 on an observed day with no meal at all', async () => {
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:00') });
      expect(await breakfastOn()).toBe(0);
    });

    it('is null on a day with nothing logged — no row, or a row whose events were all deleted', async () => {
      const walk = await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:00', 5) });
      const removed = await harness.app.inject({ method: 'DELETE', url: `/api/events/${walk.id}`, headers: bearer(token) });
      expect(removed.statusCode).toBe(204);

      const window = { from: '2026-03-03', to: '2026-03-05' };
      const rows = await summaries.findRange(userId, window.from, window.to);
      // 3 March has no row at all; 5 March has a row with no live events.
      expect(rows.map((row) => [row.localDate, row.eventsLogged])).toEqual([['2026-03-05', 0]]);
      const series = seriesFor(rows.map(extractDailyFeatures), 'breakfast_logged', window);
      expect(series.points.map((point) => point.value)).toEqual([null, null, null]);
    });

    it('does not count a deleted meal', async () => {
      const meal = await logMeal('breakfast', '07:30');
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('17:00') });
      expect(await breakfastOn()).toBe(1);

      const removed = await harness.app.inject({ method: 'DELETE', url: `/api/meals/${meal.id}`, headers: bearer(token) });
      expect(removed.statusCode).toBe(204);
      // The walk keeps the day observed, and the deleted breakfast is gone from it.
      expect(await breakfastOn()).toBe(0);
    });

    it('files a meal by its local date, not its UTC date', async () => {
      // 23:30 UTC on 4 March is 06:30 on 5 March in Ho Chi Minh City.
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('20:00') });
      await logMeal('breakfast', '06:30', 5);
      expect(utcFor('06:30', 5)).toBe('2026-03-04T23:30:00.000Z');

      expect(await breakfastOn('2026-03-05')).toBe(1);
      expect(await breakfastOn('2026-03-04')).toBe(0);
    });
  });

  describe('derived day facts', () => {
    it('stores the longest logging gap of the day', async () => {
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:00') });
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('12:00') });
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('13:30') });
      expect((await summaryFor()).metrics?.[DAY_FACT_KEYS.loggingGapHours]).toBe(5);
    });

    it('stores the planned workout time when the day plans exactly one workout', async () => {
      const plan = await inject('POST', '/api/daily-plan', {
        localDate: DATE,
        items: [
          { eventType: 'workout', title: 'Gym', plannedTime: '18:00' },
          { eventType: 'walk', title: 'Walk', plannedTime: '07:00' },
        ],
      });
      expect(plan.statusCode).toBe(201);
      // A plan write does not recompute the day; the next logged event does.
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:05') });

      const row = await summaryFor();
      expect(row.metrics?.[DAY_FACT_KEYS.workoutPlannedTime]).toBe(1080);
      expect(extractDailyFeatures(row).values.workout_planned_time).toBe(1080);
    });

    it('leaves the planned workout time unknown when the day plans several', async () => {
      await inject('POST', '/api/daily-plan', {
        localDate: DATE,
        items: [
          { eventType: 'workout', title: 'Run', plannedTime: '06:30' },
          { eventType: 'workout', title: 'Gym', plannedTime: '18:00' },
        ],
      });
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:05') });
      expect((await summaryFor()).metrics?.[DAY_FACT_KEYS.workoutPlannedTime]).toBeNull();
    });

    it('derives workout completion from workout sessions — which no endpoint writes yet', async () => {
      // No API writes `workout_sessions` (the metric is `no_write_path`), so the session is
      // inserted directly to prove the derivation reads the table correctly.
      const [event] = await harness.sql`
        insert into daily_events (user_id, local_date, type, occurred_at, title)
        values (${userId}, ${DATE}, 'workout', ${utcFor('18:00')}, 'Gym')
        returning id`;
      await harness.sql`
        insert into workout_sessions (event_id, user_id, workout_type, status)
        values (${event!['id']}, ${userId}, 'gym', 'completed')`;
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('19:00') });

      const row = await summaryFor();
      expect(row.metrics?.[DAY_FACT_KEYS.workoutCompleted]).toBe(1);
    });

    describe('workout_completed (decision D3)', () => {
      /** No endpoint writes `workout_sessions`, so sessions are inserted directly, each on its own live event. */
      const addSessions = async (statuses: Array<'completed' | 'partial' | 'skipped'>) => {
        const ids: string[] = [];
        for (const status of statuses) {
          const [event] = await harness.sql`
            insert into daily_events (user_id, local_date, type, occurred_at, title)
            values (${userId}, ${DATE}, 'workout', ${utcFor('18:00')}, 'Gym')
            returning id`;
          // The schema requires a skip reason exactly when the session was skipped.
          await harness.sql`
            insert into workout_sessions (event_id, user_id, workout_type, status, skip_reason)
            values (${event!['id']}, ${userId}, 'gym', ${status}, ${status === 'skipped' ? 'tired' : null})`;
          ids.push(event!['id'] as string);
        }
        return ids;
      };
      /** A logged walk triggers the day's recompute. */
      const completion = async () => {
        await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('19:00') });
        return (await summaryFor()).metrics?.[DAY_FACT_KEYS.workoutCompleted];
      };

      it('is 0 when the only session was skipped', async () => {
        await addSessions(['skipped']);
        expect(await completion()).toBe(0);
      });

      it('is 0 when the only session was partial', async () => {
        await addSessions(['partial']);
        expect(await completion()).toBe(0);
      });

      it('is 1 when one of several sessions was completed', async () => {
        await addSessions(['skipped', 'completed', 'partial']);
        expect(await completion()).toBe(1);
      });

      it('is 0 when several sessions exist and none was completed', async () => {
        await addSessions(['partial', 'skipped']);
        expect(await completion()).toBe(0);
      });

      it('ignores a session whose event was deleted', async () => {
        const [completedEvent] = await addSessions(['completed']);
        await harness.sql`update daily_events set deleted_at = now() where id = ${completedEvent!}`;
        expect(await completion()).toBeNull();

        await addSessions(['skipped']);
        expect(await completion()).toBe(0);
      });
    });

    it('stores unknown day facts as null, not 0', async () => {
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:00') });
      expect((await summaryFor()).metrics).toEqual({
        [DAY_FACT_KEYS.workoutCompleted]: null,
        [DAY_FACT_KEYS.workoutPlannedTime]: null,
        [DAY_FACT_KEYS.loggingGapHours]: null,
      });
    });
  });

  describe('series over a window', () => {
    it('reads a range and measures coverage against the days of the window, not the rows', async () => {
      for (const day of [1, 2, 4]) {
        await logEvent({ type: 'water', title: 'Water', occurredAt: utcFor('09:00', day), metrics: { ml: 300 } });
      }
      const window = windowEnding('2026-03-05', 5);
      const rows = await summaries.findRange(userId, window.from, window.to);
      expect(rows.map((row) => row.localDate)).toEqual(['2026-03-01', '2026-03-02', '2026-03-04']);

      const series = seriesFor(rows.map(extractDailyFeatures), 'water_ml', window);
      expect(series.points.map((point) => point.value)).toEqual([300, 300, null, 300, null]);
      expect(coverage(series)).toEqual({ days: 5, observed: 3, rate: 0.6 });
    });
  });

  describe('backfill migration 0009', () => {
    const backfill = readFileSync(
      new URL('../../src/database/migrations/0009_summary_measures_backfill.sql', import.meta.url),
      'utf8',
    );

    it('rewrites the old zero defaults from the source tables, and is idempotent', async () => {
      const rice = await foodId('cơm trắng');
      await inject('POST', '/api/meals', {
        mealType: 'lunch',
        occurredAt: utcFor('12:00'),
        items: [{ foodId: rice, quantity: 1, unit: 'bowl' }],
      });
      await logEvent({ type: 'water', title: 'Water', occurredAt: utcFor('09:00', 5), metrics: { ml: 400 } });
      await logEvent({ type: 'walk', title: 'Walk', occurredAt: utcFor('07:00', 6) });

      // What rows written before 0008 look like: every measure defaulted to 0.
      await harness.sql`
        update daily_summaries
        set water_ml = 0, distinct_foods = 0, vegetable_servings = 0, protein_servings = 0`;

      const read = async () =>
        harness.sql`
          select local_date::text as d, water_ml::text as water, distinct_foods, vegetable_servings, protein_servings
          from daily_summaries where user_id = ${userId} order by local_date`;

      await harness.sql.unsafe(backfill);
      const once = await read();
      expect(once.map((row) => ({ ...row }))).toEqual([
        { d: '2026-03-04', water: null, distinct_foods: 1, vegetable_servings: null, protein_servings: null },
        { d: '2026-03-05', water: '400.0', distinct_foods: null, vegetable_servings: null, protein_servings: null },
        { d: '2026-03-06', water: null, distinct_foods: null, vegetable_servings: null, protein_servings: null },
      ]);

      await harness.sql.unsafe(backfill);
      expect((await read()).map((row) => ({ ...row }))).toEqual(once.map((row) => ({ ...row })));
    });
  });
});
