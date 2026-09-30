import { describe, expect, it } from 'vitest';
import { addLocalDays } from '../../src/lib/local-date.js';
import {
  CORRELATION_WINDOW_DAYS,
  MAX_CORRELATION_P_VALUE,
  MIN_ABS_CORRELATION,
  MIN_CORRELATION_SAMPLE,
  READY_CORRELATION_PAIRS,
  correlationKey,
  detectCorrelations,
  evaluateCorrelation,
  type CorrelationPair,
} from '../../src/patterns/correlation.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import { METRIC_KEYS, extractDailyFeatures, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';
import { pearsonCorrelation } from '../../src/patterns/statistics.js';

/**
 * The correlation detector's gates, one at a time, on deterministic synthetic series.
 * Every fixture that is meant to sit just past or just short of a gate asserts its own
 * statistic first, so a fixture that drifts cannot make a test pass for the wrong reason.
 */

const WINDOW = windowEnding('2026-03-30', CORRELATION_WINDOW_DAYS); // 1–30 March
const MOOD_ADHERENCE: CorrelationPair = { subject: 'mood_score', object: 'plan_adherence_pct' };
const GAP_MEALS: CorrelationPair = { subject: 'logging_gap_hours', object: 'meals_logged' };

const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;

/** An observed day with only the given metrics set. */
const day = (localDate: string, values: Partial<Record<MetricKey, number | null>>): DailyFeatures => ({
  localDate,
  observed: true,
  values: { ...EMPTY, ...values },
});

/** The i-th day of the window (0 → 1 March). */
const dateAt = (i: number, from = WINDOW.from) => addLocalDays(from, i);

/** A day per value pair, on consecutive dates from the window start (or `from`). */
const series = (pair: CorrelationPair, xs: number[], ys: number[], from = WINDOW.from): DailyFeatures[] =>
  xs.map((x, i) => day(dateAt(i, from), { [pair.subject]: x, [pair.object]: ys[i] }));

const moods = (n: number) => Array.from({ length: n }, (_, i) => (i % 4) + 1);

describe('the documented gates', () => {
  it('are the values in PATTERN_ENGINE.md §3.1', () => {
    expect(MIN_CORRELATION_SAMPLE).toBe(10);
    expect(MIN_ABS_CORRELATION).toBe(0.45);
    expect(MAX_CORRELATION_P_VALUE).toBe(0.1);
    expect(CORRELATION_WINDOW_DAYS).toBe(30);
  });
});

describe('pair identity (D8)', () => {
  it('gives A ↔ B and B ↔ A one key, sorted alphabetically', () => {
    expect(correlationKey('mood_score', 'plan_adherence_pct')).toBe('correlation:mood_score:plan_adherence_pct');
    expect(correlationKey('plan_adherence_pct', 'mood_score')).toBe('correlation:mood_score:plan_adherence_pct');
    expect(correlationKey('meals_logged', 'logging_gap_hours')).toBe('correlation:logging_gap_hours:meals_logged');
  });

  it('refuses a metric paired with itself', () => {
    expect(() => correlationKey('mood_score', 'mood_score')).toThrow();
  });

  it('runs exactly the two ready pairs, with no reversed duplicate', () => {
    const keys = READY_CORRELATION_PAIRS.map((pair) => correlationKey(pair.subject, pair.object));
    expect(keys).toEqual(['correlation:mood_score:plan_adherence_pct', 'correlation:logging_gap_hours:meals_logged']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives the same statistic whichever way round the pair is evaluated', () => {
    const features = series(MOOD_ADHERENCE, moods(30), [10, 40, 60, 90, 20, 35, 70, 80, 5, 45, 65, 100, 15, 50, 55, 85, 0, 40, 75, 95, 25, 30, 60, 90, 10, 45, 70, 80, 20, 50]);
    const forward = evaluateCorrelation(features, MOOD_ADHERENCE, WINDOW);
    const reverse = evaluateCorrelation(features, { subject: 'plan_adherence_pct', object: 'mood_score' }, WINDOW);
    expect(forward.outcome).toBe('emitted');
    expect(reverse.outcome).toBe('emitted');
    if (forward.outcome !== 'emitted' || reverse.outcome !== 'emitted') return;
    expect(reverse.result.key).toBe(forward.result.key);
    expect(reverse.result.strength).toBeCloseTo(forward.result.strength, 12);
    expect(reverse.result.pValue).toBeCloseTo(forward.result.pValue, 12);
  });
});

describe('evaluateCorrelation', () => {
  it('emits a positive correlation when every gate passes', () => {
    const mood = moods(30);
    const evaluation = evaluateCorrelation(series(MOOD_ADHERENCE, mood, mood.map((m) => m * 25)), MOOD_ADHERENCE, WINDOW);

    expect(evaluation).toEqual({
      outcome: 'emitted',
      result: expect.objectContaining({
        kind: 'correlation',
        key: 'correlation:mood_score:plan_adherence_pct',
        subjectMetric: 'mood_score',
        objectMetric: 'plan_adherence_pct',
        direction: 'positive',
        strength: 1,
        pValue: 0,
        sampleSize: 30,
        coverage: 1,
        windowDays: 30,
        windowStart: '2026-03-01',
        windowEnd: '2026-03-30',
      }),
    });
    if (evaluation.outcome !== 'emitted') return;
    expect(evaluation.result.evidence).toHaveLength(30);
    expect(evaluation.result.evidence[0]).toEqual({ localDate: '2026-03-01', subject: 1, object: 25 });
  });

  it('emits a negative correlation when every gate passes', () => {
    // Longer gaps between logs, fewer meals logged.
    const gaps = Array.from({ length: 24 }, (_, i) => 2 + (i % 12));
    const meals = gaps.map((gap) => Math.max(0, 5 - Math.floor(gap / 3)));
    const evaluation = evaluateCorrelation(series(GAP_MEALS, gaps, meals), GAP_MEALS, WINDOW);

    expect(evaluation.outcome).toBe('emitted');
    if (evaluation.outcome !== 'emitted') return;
    expect(evaluation.result.direction).toBe('negative');
    expect(evaluation.result.strength).toBeGreaterThanOrEqual(MIN_ABS_CORRELATION);
    expect(evaluation.result.pValue).toBeLessThan(MAX_CORRELATION_P_VALUE);
    expect(evaluation.result.key).toBe('correlation:logging_gap_hours:meals_logged');
    expect(evaluation.result.sampleSize).toBe(24);
    expect(evaluation.result.coverage).toBe(0.8);
  });
});

describe('strength and direction (D6)', () => {
  // Longer gaps, fewer meals; mirroring the meals (5 − m) flips the sign of r and nothing else.
  const gaps = Array.from({ length: 24 }, (_, i) => 2 + (i % 12));
  const meals = gaps.map((gap, i) => Math.max(0, 5 - Math.floor(gap / 3) + (i % 5 === 0 ? 1 : 0)));
  const mirrored = meals.map((m) => 5 - m);

  it('reports a negative r as direction negative with strength |r|', () => {
    const r = pearsonCorrelation(gaps, meals)!.r;
    expect(r).toBeLessThan(-0.7);
    expect(r).toBeGreaterThan(-1);

    const evaluation = evaluateCorrelation(series(GAP_MEALS, gaps, meals), GAP_MEALS, WINDOW);
    expect(evaluation.outcome).toBe('emitted');
    if (evaluation.outcome !== 'emitted') return;
    expect(evaluation.result.direction).toBe('negative');
    expect(evaluation.result.strength).toBe(Math.abs(r));
  });

  it('reports a positive r as direction positive with strength r', () => {
    const r = pearsonCorrelation(gaps, mirrored)!.r;
    expect(r).toBeGreaterThan(0.7);
    expect(r).toBeLessThan(1);

    const evaluation = evaluateCorrelation(series(GAP_MEALS, gaps, mirrored), GAP_MEALS, WINDOW);
    expect(evaluation.outcome).toBe('emitted');
    if (evaluation.outcome !== 'emitted') return;
    expect(evaluation.result.direction).toBe('positive');
    expect(evaluation.result.strength).toBe(r);
  });

  it('gives mirrored series the same strength in 0..1 and opposite directions', () => {
    const negative = evaluateCorrelation(series(GAP_MEALS, gaps, meals), GAP_MEALS, WINDOW);
    const positive = evaluateCorrelation(series(GAP_MEALS, gaps, mirrored), GAP_MEALS, WINDOW);
    if (negative.outcome !== 'emitted' || positive.outcome !== 'emitted') throw new Error('both should emit');

    expect(negative.result.strength).toBeCloseTo(positive.result.strength, 12);
    for (const { result } of [negative, positive]) {
      expect(result.strength).toBeGreaterThanOrEqual(0);
      expect(result.strength).toBeLessThanOrEqual(1);
    }
    expect([negative.result.direction, positive.result.direction]).toEqual(['negative', 'positive']);
  });

  it('rejects fewer than 10 complete pairs, however perfect the fit', () => {
    const window = windowEnding('2026-03-12', 12);
    const mood = moods(9);
    const evaluation = evaluateCorrelation(series(MOOD_ADHERENCE, mood, mood.map((m) => m * 25), window.from), MOOD_ADHERENCE, window);
    // 9 of 12 days is 75% coverage: only the sample gate can have refused it.
    expect(evaluation).toMatchObject({ outcome: 'rejected', reason: 'insufficient_sample', sampleSize: 9, coverage: 0.75 });
  });

  it('measures coverage against the window: 20 of 30 days is refused, 21 of 30 passes', () => {
    const mood = moods(21);
    const perfect = (n: number) => series(MOOD_ADHERENCE, mood.slice(0, n), mood.slice(0, n).map((m) => m * 25));

    expect(evaluateCorrelation(perfect(20), MOOD_ADHERENCE, WINDOW)).toMatchObject({
      outcome: 'rejected',
      reason: 'low_coverage',
      sampleSize: 20,
    });
    expect(evaluateCorrelation(perfect(21), MOOD_ADHERENCE, WINDOW)).toMatchObject({
      outcome: 'emitted',
      result: { sampleSize: 21, coverage: 0.7 },
    });
  });

  it('rejects a weak correlation over a full window', () => {
    const mood = moods(30);
    const adherence = [50, 20, 80, 40, 60, 30, 70, 50, 40, 90, 20, 60, 30, 50, 80, 40, 70, 20, 60, 50, 40, 90, 30, 60, 50, 70, 20, 80, 40, 60];
    expect(Math.abs(pearsonCorrelation(mood, adherence)!.r)).toBeLessThan(MIN_ABS_CORRELATION);
    expect(evaluateCorrelation(series(MOOD_ADHERENCE, mood, adherence), MOOD_ADHERENCE, WINDOW)).toMatchObject({
      outcome: 'rejected',
      reason: 'weak',
      sampleSize: 30,
    });
  });

  it('rejects |r| ≥ 0.45 that is not significant at p < 0.10', () => {
    // n = 10 in a 14-day window (71% coverage): the sample and coverage gates pass, and
    // the critical |r| at n = 10 is about 0.549, so r ≈ 0.48 fails only on p.
    const window = windowEnding('2026-03-14', 14);
    const mood = [1, 2, 3, 4, 1, 2, 3, 4, 1, 2];
    const adherence = [27, 36, 99, 54, 36, 27, 45, 99, 72, 81];
    const stats = pearsonCorrelation(mood, adherence)!;
    expect(stats.r).toBeGreaterThanOrEqual(MIN_ABS_CORRELATION);
    expect(stats.pValue).toBeGreaterThanOrEqual(MAX_CORRELATION_P_VALUE);

    expect(evaluateCorrelation(series(MOOD_ADHERENCE, mood, adherence, window.from), MOOD_ADHERENCE, window)).toMatchObject({
      outcome: 'rejected',
      reason: 'not_significant',
      sampleSize: 10,
    });
  });

  it('rejects a constant series rather than fabricating a correlation', () => {
    const mood = moods(30);
    expect(evaluateCorrelation(series(MOOD_ADHERENCE, mood, mood.map(() => 100)), MOOD_ADHERENCE, WINDOW)).toMatchObject({
      outcome: 'rejected',
      reason: 'no_variance',
    });
    expect(evaluateCorrelation(series(MOOD_ADHERENCE, mood.map(() => 3), mood.map((m) => m * 25)), MOOD_ADHERENCE, WINDOW)).toMatchObject({
      outcome: 'rejected',
      reason: 'no_variance',
    });
  });

  it('pairs only days with both values, never treating a gap as 0', () => {
    const mood = moods(30);
    const features = series(MOOD_ADHERENCE, mood, mood.map((m) => m * 25));
    // Six days lose one side, in every way a value can be missing.
    features[3]!.values.mood_score = null;
    features[7]!.values.plan_adherence_pct = null;
    (features[11]!.values as Record<string, unknown>)['mood_score'] = undefined;
    features[15]!.values.plan_adherence_pct = Number.NaN;
    features[19]!.values.mood_score = Number.POSITIVE_INFINITY;
    features[23]!.values.plan_adherence_pct = Number.NEGATIVE_INFINITY;

    const evaluation = evaluateCorrelation(features, MOOD_ADHERENCE, WINDOW);
    expect(evaluation.outcome).toBe('emitted');
    if (evaluation.outcome !== 'emitted') return;
    expect(evaluation.result.sampleSize).toBe(24);
    expect(evaluation.result.coverage).toBe(0.8);
    expect(evaluation.result.strength).toBe(1);
    const dates = evaluation.result.evidence.map((point) => point.localDate);
    for (const i of [3, 7, 11, 15, 19, 23]) expect(dates).not.toContain(dateAt(i));
    expect(evaluation.result.evidence.every((point) => Number.isFinite(point.subject) && Number.isFinite(point.object))).toBe(true);
  });

  it('ignores days outside the window and unobserved days', () => {
    const mood = moods(30);
    const inside = series(MOOD_ADHERENCE, mood, mood.map((m) => m * 25));
    const outside = series(MOOD_ADHERENCE, [4, 1], [0, 100], '2026-02-27');
    const unobserved: DailyFeatures = { localDate: '2026-03-31', observed: false, values: { ...EMPTY } };
    const evaluation = evaluateCorrelation([...outside, ...inside, unobserved], MOOD_ADHERENCE, WINDOW);
    expect(evaluation).toMatchObject({ outcome: 'emitted', result: { sampleSize: 30, strength: 1 } });
  });
});

describe('detectCorrelations', () => {
  it('returns only the ready pairs that pass, and both when both do', () => {
    const mood = moods(30);
    const gaps = Array.from({ length: 30 }, (_, i) => 2 + (i % 10));
    const features = mood.map((m, i) =>
      day(dateAt(i), { mood_score: m, plan_adherence_pct: m * 25, logging_gap_hours: gaps[i]!, meals_logged: 12 - gaps[i]! }),
    );
    const results = detectCorrelations(features, WINDOW);
    expect(results.map((result) => [result.key, result.direction])).toEqual([
      ['correlation:mood_score:plan_adherence_pct', 'positive'],
      ['correlation:logging_gap_hours:meals_logged', 'negative'],
    ]);
  });

  it('never evaluates a pair that is not ready, however strong it is', () => {
    // Perfectly correlated, but every pair here waits on D1, D3 or D5.
    const features = moods(30).map((m, i) =>
      day(dateAt(i), {
        bedtime_min: 1300 + m * 20,
        breakfast_logged: m > 2 ? 1 : 0,
        sleep_minutes: 360 + m * 30,
        workout_completed: m > 2 ? 1 : 0,
        workout_planned_time: 1000 + m * 30,
        distinct_foods: m + 2,
        vegetable_servings: m,
      }),
    );
    expect(detectCorrelations(features, WINDOW)).toEqual([]);
  });

  it('finds nothing in an empty window', () => {
    expect(detectCorrelations([], WINDOW)).toEqual([]);
  });

  it('reads the metric layer directly: summary rows → features → detector', () => {
    const moodNames = ['low', 'okay', 'good', 'great'] as const;
    const rows = moods(30).map((m, i) =>
      extractDailyFeatures({
        localDate: dateAt(i),
        eventsLogged: 2,
        mealsLogged: 0,
        vegetableServings: null,
        proteinServings: null,
        distinctFoods: null,
        waterMl: null,
        sleepMinutes: null,
        firstMealTime: null,
        lastMealTime: null,
        bedtime: null,
        planAdherencePct: (m * 25).toFixed(2),
        mood: moodNames[m - 1]!,
        metrics: null,
      }),
    );
    expect(detectCorrelations(rows, WINDOW).map((result) => result.key)).toEqual([
      'correlation:mood_score:plan_adherence_pct',
    ]);
  });

  it('describes association only: a sign, never a verdict or a cause', () => {
    const mood = moods(30);
    const [result] = detectCorrelations(series(MOOD_ADHERENCE, mood, mood.map((m) => 100 - m * 25)), WINDOW);
    expect(result!.direction).toBe('negative');
    expect(JSON.stringify(result)).not.toMatch(/caus|good|bad|healthy|better|worse|because/i);
  });

  it('is deterministic', () => {
    const mood = moods(30);
    const features = series(MOOD_ADHERENCE, mood, mood.map((m) => m * 20 + (m % 2) * 7));
    expect(detectCorrelations(features, WINDOW)).toEqual(detectCorrelations([...features], WINDOW));
  });
});
