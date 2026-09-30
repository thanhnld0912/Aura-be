import { describe, expect, it } from 'vitest';
import { toLocalTime } from '../../src/lib/local-date.js';
import { coverage, seriesFor, windowDates, windowEnding } from '../../src/patterns/coverage.js';
import {
  DAY_FACT_KEYS,
  deriveDistinctFoods,
  deriveLoggingGapHours,
  deriveWorkoutCompleted,
  deriveWorkoutPlannedTime,
} from '../../src/patterns/day-facts.js';
import {
  BREAKFAST_BEFORE_MIN,
  METRICS,
  METRIC_KEYS,
  clockMinutes,
  extractDailyFeatures,
  type DailyFeatures,
  type SummarySnapshot,
} from '../../src/patterns/metrics.js';

/**
 * Pattern Engine layer 1: day facts, metric extraction and coverage. Pure, so every rule is
 * pinned with fixed inputs — above all the rule that an absence never becomes a 0.
 */

const row = (overrides: Partial<SummarySnapshot> = {}): SummarySnapshot => ({
  localDate: '2026-03-04',
  eventsLogged: 3,
  mealsLogged: 2,
  vegetableServings: null,
  proteinServings: null,
  distinctFoods: 4,
  waterMl: '750.0',
  sleepMinutes: 430,
  firstMealTime: '07:45:00',
  lastMealTime: '19:30:00',
  bedtime: '23:15:00',
  planAdherencePct: '66.67',
  mood: 'good',
  metrics: {
    [DAY_FACT_KEYS.workoutCompleted]: 1,
    [DAY_FACT_KEYS.workoutPlannedTime]: 1080,
    [DAY_FACT_KEYS.loggingGapHours]: 5.5,
  },
  ...overrides,
});

describe('clockMinutes', () => {
  it('reads a wall-clock time as minutes past midnight, with or without seconds', () => {
    expect(clockMinutes('17:30')).toBe(1050);
    expect(clockMinutes('17:30:00')).toBe(1050);
    expect(clockMinutes('17:30:59.123')).toBe(1050);
  });

  it('puts midnight at 0 and the last minute of the day at 1439', () => {
    expect(clockMinutes('00:00:00')).toBe(0);
    expect(clockMinutes('23:59:00')).toBe(1439);
  });

  it('keeps null as null', () => {
    expect(clockMinutes(null)).toBeNull();
  });

  it('refuses a malformed time instead of calling it missing', () => {
    expect(() => clockMinutes('24:00')).toThrow();
    expect(() => clockMinutes('7:30')).toThrow();
    expect(() => clockMinutes('')).toThrow();
  });

  it("measures the user's wall clock, which the summary already stores in their timezone", () => {
    // 16:30 UTC on 3 March is 23:30 in Ho Chi Minh City and 11:30 in New York.
    const instant = new Date('2026-03-03T16:30:00Z');
    expect(clockMinutes(toLocalTime(instant, 'Asia/Ho_Chi_Minh'))).toBe(1410);
    expect(clockMinutes(toLocalTime(instant, 'America/New_York'))).toBe(690);
    // 17:30 UTC crosses local midnight in Ho Chi Minh City.
    expect(clockMinutes(toLocalTime(new Date('2026-03-03T17:30:00Z'), 'Asia/Ho_Chi_Minh'))).toBe(30);
  });

  it('does not pretend to resolve bedtimes across midnight: 23:30 and 00:30 are far apart on this scale', () => {
    expect(clockMinutes('23:30')).toBe(1410);
    expect(clockMinutes('00:30')).toBe(30);
    expect(METRICS.bedtime_min.scale).toBe('clock');
    expect(METRICS.bedtime_min.unresolved).toMatch(/midnight/);
  });
});

describe('day facts', () => {
  it('workout_completed: completed is 1, a logged skip is 0, nothing logged is unknown', () => {
    expect(deriveWorkoutCompleted(['completed'])).toBe(1);
    expect(deriveWorkoutCompleted(['skipped', 'completed'])).toBe(1);
    expect(deriveWorkoutCompleted(['skipped'])).toBe(0);
    expect(deriveWorkoutCompleted([])).toBeNull();
  });

  it('workout_completed: leaves a partial-only day unknown, because no document says what partial counts as', () => {
    expect(deriveWorkoutCompleted(['partial'])).toBeNull();
    expect(deriveWorkoutCompleted(['partial', 'skipped'])).toBeNull();
  });

  it('workout_planned_time: one planned workout gives its time; none or several give nothing', () => {
    expect(deriveWorkoutPlannedTime([1080])).toBe(1080);
    expect(deriveWorkoutPlannedTime([])).toBeNull();
    expect(deriveWorkoutPlannedTime([420, 1080])).toBeNull();
  });

  it('logging_gap_hours: the widest gap between consecutive events, in any input order', () => {
    const at = (time: string) => new Date(`2026-03-04T${time}:00Z`);
    expect(deriveLoggingGapHours([at('12:00'), at('07:00'), at('13:30')])).toBe(5);
    expect(deriveLoggingGapHours([at('07:00'), at('07:20')])).toBe(0.33);
  });

  it('logging_gap_hours: one event has no gap, which is unknown rather than 0', () => {
    expect(deriveLoggingGapHours([new Date('2026-03-04T07:00:00Z')])).toBeNull();
    expect(deriveLoggingGapHours([])).toBeNull();
  });

  it('distinct_foods: counts resolved foods; a day with none resolved is unknown, not 0', () => {
    expect(deriveDistinctFoods(3)).toBe(3);
    expect(deriveDistinctFoods(0)).toBeNull();
  });
});

describe('extractDailyFeatures', () => {
  it('names every documented metric, and every one is reachable from a summary row', () => {
    const { values } = extractDailyFeatures(row());
    expect(Object.keys(values).sort()).toEqual([...METRIC_KEYS].sort());
    expect(Object.keys(METRICS).sort()).toEqual([...METRIC_KEYS].sort());
  });

  it('turns a full row into numbers', () => {
    expect(extractDailyFeatures(row())).toEqual({
      localDate: '2026-03-04',
      observed: true,
      values: {
        bedtime_min: 1395,
        sleep_minutes: 430,
        first_meal_min: 465,
        last_meal_min: 1170,
        breakfast_logged: 1,
        meals_logged: 2,
        vegetable_servings: null,
        protein_servings: null,
        distinct_foods: 4,
        workout_completed: 1,
        workout_planned_time: 1080,
        plan_adherence_pct: 66.67,
        mood_score: 3,
        water_ml: 750,
        logging_gap_hours: 5.5,
      },
    });
  });

  it('maps mood to its 1–4 ordinal', () => {
    const score = (mood: SummarySnapshot['mood']) => extractDailyFeatures(row({ mood })).values.mood_score;
    expect([score('low'), score('okay'), score('good'), score('great'), score(null)]).toEqual([1, 2, 3, 4, null]);
  });

  it('calls breakfast logged only for a first meal strictly before 10:30', () => {
    const breakfast = (firstMealTime: string) =>
      extractDailyFeatures(row({ firstMealTime })).values.breakfast_logged;
    expect(BREAKFAST_BEFORE_MIN).toBe(630);
    expect(breakfast('10:29:00')).toBe(1);
    expect(breakfast('10:30:00')).toBe(0);
    expect(breakfast('13:00:00')).toBe(0);
  });

  it('leaves breakfast unknown on a day with no meal logged, rather than calling it skipped', () => {
    const { values } = extractDailyFeatures(row({ mealsLogged: 0, firstMealTime: null, lastMealTime: null }));
    expect(values.breakfast_logged).toBeNull();
    expect(values.first_meal_min).toBeNull();
    // The count itself is a measurement of the log: this day had logs, and no meal among them.
    expect(values.meals_logged).toBe(0);
  });

  it('keeps missing water, nutrition and sleep missing — never 0', () => {
    const { values } = extractDailyFeatures(
      row({ waterMl: null, distinctFoods: null, sleepMinutes: null, bedtime: null, planAdherencePct: null, mood: null }),
    );
    expect(values.water_ml).toBeNull();
    expect(values.distinct_foods).toBeNull();
    expect(values.sleep_minutes).toBeNull();
    expect(values.bedtime_min).toBeNull();
    expect(values.plan_adherence_pct).toBeNull();
    expect(values.mood_score).toBeNull();
  });

  it('keeps a measured zero a zero', () => {
    const { values } = extractDailyFeatures(
      row({ waterMl: '0.0', planAdherencePct: '0.00', metrics: { [DAY_FACT_KEYS.workoutCompleted]: 0 } }),
    );
    expect(values.water_ml).toBe(0);
    expect(values.plan_adherence_pct).toBe(0);
    expect(values.workout_completed).toBe(0);
  });

  it('never produces a serving count: no document defines one', () => {
    expect(METRICS.vegetable_servings.status).toBe('undefined_definition');
    expect(METRICS.protein_servings.status).toBe('undefined_definition');
    const { values } = extractDailyFeatures(row());
    expect(values.vegetable_servings).toBeNull();
    expect(values.protein_servings).toBeNull();
  });

  it('reads a day fact that was never computed (an older row) as missing', () => {
    const { values } = extractDailyFeatures(row({ metrics: null }));
    expect(values.workout_completed).toBeNull();
    expect(values.workout_planned_time).toBeNull();
    expect(values.logging_gap_hours).toBeNull();
  });

  it('treats a row whose events were all deleted as an unobserved day', () => {
    const features = extractDailyFeatures(row({ eventsLogged: 0, mealsLogged: 0 }));
    expect(features.observed).toBe(false);
    expect(Object.values(features.values).every((value) => value === null)).toBe(true);
  });

  it('is deterministic', () => {
    expect(extractDailyFeatures(row())).toEqual(extractDailyFeatures(row()));
  });
});

describe('coverage', () => {
  const window = windowEnding('2026-03-30', 30);

  /** A day observed with `water_ml` set, for each date given. */
  const days = (dates: string[]): DailyFeatures[] =>
    dates.map((localDate) => extractDailyFeatures(row({ localDate })));

  const firstN = (n: number) => windowDates(window).slice(0, n);

  it('spans every calendar day of the window, inclusive', () => {
    expect(window).toEqual({ from: '2026-03-01', to: '2026-03-30' });
    expect(windowDates(window)).toHaveLength(30);
    expect(windowDates({ from: '2026-02-27', to: '2026-03-02' })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('30 of 30 days is full coverage', () => {
    expect(coverage(seriesFor(days(firstN(30)), 'water_ml', window))).toEqual({ days: 30, observed: 30, rate: 1 });
  });

  it('21 of 30 days is exactly 70%', () => {
    const result = coverage(seriesFor(days(firstN(21)), 'water_ml', window));
    expect(result).toEqual({ days: 30, observed: 21, rate: 0.7 });
    expect(result.rate >= 0.7).toBe(true);
  });

  it('20 of 30 days is below 70% — rows that exist are not the denominator', () => {
    const result = coverage(seriesFor(days(firstN(20)), 'water_ml', window));
    expect(result.observed).toBe(20);
    expect(result.days).toBe(30);
    expect(result.rate).toBeCloseTo(0.6667, 4);
    expect(result.rate < 0.7).toBe(true);
  });

  it('0 of 30 days is zero coverage', () => {
    expect(coverage(seriesFor([], 'water_ml', window))).toEqual({ days: 30, observed: 0, rate: 0 });
  });

  it('counts gaps in the middle of the window, and keeps them in place in the series', () => {
    const dates = windowDates(window).filter((_, i) => i < 10 || i >= 15);
    const series = seriesFor(days(dates), 'water_ml', window);
    expect(series.points).toHaveLength(30);
    expect(series.points.slice(10, 15).map((point) => point.value)).toEqual([null, null, null, null, null]);
    expect(series.points[9]!.value).toBe(750);
    expect(coverage(series)).toEqual({ days: 30, observed: 25, rate: 25 / 30 });
  });

  it('counts a row with a null value as a gap, not an observation', () => {
    const features = [
      ...days(firstN(2)),
      extractDailyFeatures(row({ localDate: firstN(3)[2]!, waterMl: null })),
    ];
    expect(coverage(seriesFor(features, 'water_ml', window)).observed).toBe(2);
  });

  it('for a pair, counts only the days on which both metrics are present', () => {
    const features = [
      extractDailyFeatures(row({ localDate: '2026-03-01' })),
      extractDailyFeatures(row({ localDate: '2026-03-02', bedtime: null })),
      extractDailyFeatures(row({ localDate: '2026-03-03', mealsLogged: 0, firstMealTime: null })),
    ];
    const pair = coverage(
      seriesFor(features, 'bedtime_min', window),
      seriesFor(features, 'breakfast_logged', window),
    );
    expect(pair).toEqual({ days: 30, observed: 1, rate: 1 / 30 });
  });

  it('ignores rows outside the window', () => {
    const outside = days(['2026-02-28', '2026-03-31']);
    expect(coverage(seriesFor(outside, 'water_ml', window)).observed).toBe(0);
  });

  it('refuses series over different windows, and two rows for one day', () => {
    const a = seriesFor([], 'water_ml', window);
    const b = seriesFor([], 'water_ml', windowEnding('2026-03-31', 30));
    expect(() => coverage(a, b)).toThrow();
    expect(() => seriesFor(days(['2026-03-02', '2026-03-02']), 'water_ml', window)).toThrow();
    expect(() => coverage()).toThrow();
  });

  it('refuses a backwards or malformed window', () => {
    expect(() => windowDates({ from: '2026-03-02', to: '2026-03-01' })).toThrow();
    expect(() => windowDates({ from: '2026-3-1', to: '2026-03-02' })).toThrow();
    expect(() => windowEnding('2026-03-02', 0)).toThrow();
  });
});
