import { describe, expect, it } from 'vitest';
import { PATTERN_KINDS } from '../../src/insights/pattern-evidence.js';
import { addLocalDays } from '../../src/lib/local-date.js';
import { READY_CORRELATION_PAIRS, evaluateCorrelation } from '../../src/patterns/correlation.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import { METRIC_KEYS, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';
import {
  DETECTOR_REGISTRY,
  approvedCorrelationPair,
  emittingFamilies,
  runApprovedDetectors,
} from '../../src/patterns/registry.js';
import { welchTTest } from '../../src/patterns/statistics.js';
import {
  APPROVED_TIMING_CONDITIONS,
  MAX_TIMING_P_VALUE,
  MIN_TIMING_GROUP,
  MIN_TIMING_RATE_DIFFERENCE,
  TIMING_WINDOW_DAYS,
  evaluateTiming,
  timingKey,
} from '../../src/patterns/timing.js';
import { MIN_TREND_R_SQUARED, MIN_TREND_SAMPLE, assessTrend, isTrendable } from '../../src/patterns/trend.js';
import { noiseDays } from '../helpers/pattern-noise.js';

/**
 * The detector layer above the correlation detector: the registry that decides which
 * families may emit, the timing evaluation and the trend assessment (both built, both
 * blocked from emitting), and the seeded noise fixture of PATTERN_ENGINE.md §9 / D13.
 */

const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;
const day = (localDate: string, values: Partial<Record<MetricKey, number | null>>): DailyFeatures => ({
  localDate,
  observed: true,
  values: { ...EMPTY, ...values },
});

const W30 = windowEnding('2026-03-30', 30); // 1–30 March
const W45 = windowEnding('2026-04-14', TIMING_WINDOW_DAYS); // 1 March – 14 April
const LATE_WORKOUTS = APPROVED_TIMING_CONDITIONS[0]!;

/** Timing days from W45's start: each entry is [planned minutes, completed 0/1 or null]. */
const timingDays = (entries: Array<[number | null, number | null]>): DailyFeatures[] =>
  entries.map(([planned, completed], i) =>
    day(addLocalDays(W45.from, i), { workout_planned_time: planned, workout_completed: completed }),
  );

/** `n` late (19:00) and `m` early (07:00) days, with the given number completed in each. */
const splitDays = (late: { n: number; done: number }, early: { n: number; done: number }) =>
  timingDays([
    ...Array.from({ length: late.n }, (_, i): [number, number] => [1140, i < late.done ? 1 : 0]),
    ...Array.from({ length: early.n }, (_, i): [number, number] => [420, i < early.done ? 1 : 0]),
  ]);

// ── Registry ───────────────────────────────────────────────────────────────────

describe('detector registry', () => {
  it('lists every pattern kind exactly once, across the four §3 families', () => {
    const kinds = Object.values(DETECTOR_REGISTRY).flatMap((registration) => registration.kinds);
    expect([...kinds].sort()).toEqual([...PATTERN_KINDS].sort());
    expect(Object.keys(DETECTOR_REGISTRY).sort()).toEqual(['correlation', 'frequency_streak', 'timing', 'trend']);
  });

  it('lets only correlation emit, and names what blocks every other family', () => {
    expect(emittingFamilies()).toEqual(['correlation']);
    expect(DETECTOR_REGISTRY.correlation.blockedBy).toEqual([]);
    expect(DETECTOR_REGISTRY.timing.blockedBy.join(' ')).toMatch(/D16/);
    expect(DETECTOR_REGISTRY.trend.blockedBy.join(' ')).toMatch(/D9/);
    expect(DETECTOR_REGISTRY.trend.blockedBy.join(' ')).toMatch(/D16/);
    expect(DETECTOR_REGISTRY.frequency_streak.blockedBy.join(' ')).toMatch(/D16/);
    for (const registration of Object.values(DETECTOR_REGISTRY)) {
      expect(registration.emits).toBe(registration.blockedBy.length === 0);
    }
  });

  it('approves exactly the two ready correlation pairs, in either order, as one pair', () => {
    const forward = approvedCorrelationPair('mood_score', 'plan_adherence_pct');
    expect(forward).toEqual({ subject: 'mood_score', object: 'plan_adherence_pct' });
    expect(approvedCorrelationPair('plan_adherence_pct', 'mood_score')).toBe(forward);
    expect(approvedCorrelationPair('meals_logged', 'logging_gap_hours')).toEqual({
      subject: 'logging_gap_hours',
      object: 'meals_logged',
    });
    expect(READY_CORRELATION_PAIRS).toHaveLength(2);
  });

  it('refuses every other pair — including the blocked ones and a metric with itself', () => {
    expect(approvedCorrelationPair('bedtime_min', 'breakfast_logged')).toBeNull();
    expect(approvedCorrelationPair('distinct_foods', 'vegetable_servings')).toBeNull();
    expect(approvedCorrelationPair('sleep_minutes', 'workout_completed')).toBeNull();
    expect(approvedCorrelationPair('workout_planned_time', 'workout_completed')).toBeNull();
    expect(approvedCorrelationPair('water_ml', 'mood_score')).toBeNull();
    expect(approvedCorrelationPair('mood_score', 'mood_score')).toBeNull();
  });

  it('emits no timing or trend result, however strong the signal in the data', () => {
    // Every family has a perfect signal here; only the approved correlation may come out.
    const features = Array.from({ length: 30 }, (_, i) =>
      day(addLocalDays(W30.from, i), {
        mood_score: (i % 4) + 1,
        plan_adherence_pct: ((i % 4) + 1) * 25,
        distinct_foods: i + 1,
        workout_planned_time: i % 2 ? 1140 : 420,
        workout_completed: i % 2 ? 0 : 1,
      }),
    );
    expect(assessTrend(features, 'distinct_foods', W30).outcome).toBe('passes_decided_gates');

    const results = runApprovedDetectors(features, { correlation: W30 });
    expect(results.map((result) => result.key)).toEqual(['correlation:mood_score:plan_adherence_pct']);
    expect(results.every((result) => result.kind === 'correlation')).toBe(true);
  });
});

// ── Timing (evaluation only) ───────────────────────────────────────────────────

describe('timing evaluation (PATTERN_ENGINE.md §3.3)', () => {
  it('uses the documented gates, condition and window', () => {
    expect(MIN_TIMING_GROUP).toBe(5);
    expect(MIN_TIMING_RATE_DIFFERENCE).toBe(0.25);
    expect(MAX_TIMING_P_VALUE).toBe(0.1);
    expect(TIMING_WINDOW_DAYS).toBe(45);
    expect(APPROVED_TIMING_CONDITIONS).toEqual([
      { conditionMetric: 'workout_planned_time', fromValue: 1080, outcomeMetric: 'workout_completed' },
    ]);
    expect(timingKey(LATE_WORKOUTS)).toBe('timing:workout_completed:workout_planned_time_ge_1080');
  });

  it('passes a clear difference: late workouts completed less often', () => {
    const evaluation = evaluateTiming(splitDays({ n: 20, done: 4 }, { n: 20, done: 16 }), LATE_WORKOUTS, W45);
    expect(evaluation.outcome).toBe('passes_gates');
    if (evaluation.outcome !== 'passes_gates') return;
    const { candidate } = evaluation;
    expect(candidate).toMatchObject({
      kind: 'timing',
      key: 'timing:workout_completed:workout_planned_time_ge_1080',
      subjectMetric: 'workout_planned_time',
      objectMetric: 'workout_completed',
      direction: 'negative',
      sampleSize: 40,
      windowDays: 45,
      groups: { atOrAfter: { n: 20, rate: 0.2 }, before: { n: 20, rate: 0.8 } },
      condition: { metric: 'workout_planned_time', fromValue: 1080 },
    });
    expect(candidate.strength).toBeCloseTo(-0.6, 12);
    expect(candidate.pValue).toBeLessThan(MAX_TIMING_P_VALUE);
    expect(candidate.coverage).toBeCloseTo(40 / 45, 12);
    expect(candidate.evidence).toHaveLength(40);
  });

  it('puts 18:00 itself in the late group and 17:59 in the early one', () => {
    const evaluation = evaluateTiming(
      timingDays([...Array.from({ length: 5 }, (): [number, number] => [1080, 0]), ...Array.from({ length: 5 }, (): [number, number] => [1079, 1])]),
      LATE_WORKOUTS,
      W45,
    );
    // Both groups constant (0 vs 1): no variance for Welch — see the no_variance test below.
    expect(evaluation).toMatchObject({ outcome: 'rejected', groups: { atOrAfter: { n: 5 }, before: { n: 5 } } });
  });

  it('rejects a group smaller than five days', () => {
    expect(evaluateTiming(splitDays({ n: 4, done: 0 }, { n: 20, done: 18 }), LATE_WORKOUTS, W45)).toMatchObject({
      outcome: 'rejected',
      reason: 'insufficient_sample',
      groups: { atOrAfter: { n: 4 }, before: { n: 20 } },
    });
  });

  it('rejects a difference below 0.25', () => {
    expect(evaluateTiming(splitDays({ n: 20, done: 10 }, { n: 20, done: 12 }), LATE_WORKOUTS, W45)).toMatchObject({
      outcome: 'rejected',
      reason: 'weak',
    });
  });

  it('rejects a large difference that is not significant at p < 0.10', () => {
    // 2/5 vs 4/5: a 0.4 difference on five days a side.
    const late = [1, 1, 0, 0, 0];
    const early = [1, 1, 1, 1, 0];
    const test = welchTTest(late, early)!;
    expect(test.pValue).toBeGreaterThanOrEqual(MAX_TIMING_P_VALUE);
    expect(evaluateTiming(splitDays({ n: 5, done: 2 }, { n: 5, done: 4 }), LATE_WORKOUTS, W45)).toMatchObject({
      outcome: 'rejected',
      reason: 'not_significant',
    });
  });

  it('refuses rather than asserts when both groups are constant, even at 0 vs 1', () => {
    // Welch's t is undefined without within-group variance. The engine says nothing instead
    // of inventing a p-value — a known limitation, recorded for the decision to unblock timing.
    expect(evaluateTiming(splitDays({ n: 10, done: 0 }, { n: 10, done: 10 }), LATE_WORKOUTS, W45)).toMatchObject({
      outcome: 'rejected',
      reason: 'no_variance',
    });
  });

  it('leaves a day out when either side is missing — an unlogged session is not "not completed"', () => {
    const base = splitDays({ n: 20, done: 4 }, { n: 20, done: 16 });
    const withGaps = [
      ...base,
      // Planned, but no session logged (D3: null): must not join the late group as a 0.
      ...timingDays(Array.from({ length: 5 }, (): [number, number | null] => [1140, null])).map((d, i) => ({
        ...d,
        localDate: addLocalDays(W45.from, 40 + i),
      })),
    ];
    withGaps[0]!.values.workout_planned_time = null;
    withGaps[1]!.values.workout_completed = Number.NaN;

    const evaluation = evaluateTiming(withGaps, LATE_WORKOUTS, W45);
    expect(evaluation.outcome).toBe('passes_gates');
    if (evaluation.outcome !== 'passes_gates') return;
    expect(evaluation.candidate.groups.atOrAfter.n).toBe(18);
    expect(evaluation.candidate.sampleSize).toBe(38);
    expect(evaluation.candidate.evidence.every((point) => Number.isFinite(point.outcome))).toBe(true);
  });
});

// ── Trend (assessment only) ────────────────────────────────────────────────────

describe('trend assessment (PATTERN_ENGINE.md §3.2, D9)', () => {
  const rising = (values: Array<number | null>, metric: MetricKey = 'distinct_foods') =>
    values.map((value, i) => day(addLocalDays(W30.from, i), { [metric]: value }));

  it('uses the decided gates only', () => {
    expect(MIN_TREND_SAMPLE).toBe(14);
    expect(MIN_TREND_R_SQUARED).toBe(0.3);
  });

  it('trends only linear scales with a data source (not clock, binary or undefined metrics)', () => {
    expect(isTrendable('distinct_foods')).toBe(true);
    expect(isTrendable('meals_logged')).toBe(true);
    expect(isTrendable('bedtime_min')).toBe(false);
    expect(isTrendable('first_meal_min')).toBe(false);
    expect(isTrendable('breakfast_logged')).toBe(false);
    expect(isTrendable('workout_completed')).toBe(false);
    expect(isTrendable('vegetable_servings')).toBe(false);
    expect(assessTrend(rising(Array.from({ length: 30 }, (_, i) => 1300 + i), 'bedtime_min'), 'bedtime_min', W30)).toMatchObject({
      outcome: 'rejected',
      reason: 'not_trendable',
    });
  });

  it('fits a clear rise and reports it — as an assessment, not a pattern', () => {
    const evaluation = assessTrend(rising(Array.from({ length: 30 }, (_, i) => 2 + i)), 'distinct_foods', W30);
    expect(evaluation).toEqual({
      outcome: 'passes_decided_gates',
      assessment: expect.objectContaining({ metric: 'distinct_foods', sampleSize: 30, windowDays: 30 }),
    });
    if (evaluation.outcome !== 'passes_decided_gates') return;
    expect(evaluation.assessment.slopePerDay).toBeCloseTo(1, 12);
    expect(evaluation.assessment.rSquared).toBeCloseTo(1, 12);
    expect(DETECTOR_REGISTRY.trend.emits).toBe(false);
  });

  it('applies no minimum slope of its own: a tiny, perfect rise still passes the decided gates', () => {
    // D9's magnitude gate is open; this module must not stand in for it.
    const evaluation = assessTrend(rising(Array.from({ length: 30 }, (_, i) => 10 + i * 0.001)), 'distinct_foods', W30);
    expect(evaluation.outcome).toBe('passes_decided_gates');
  });

  it('measures time in calendar days, so gaps do not compress the slope', () => {
    // One value per day equals its day offset, with every third day missing.
    const values = Array.from({ length: 30 }, (_, i) => (i % 3 === 2 ? null : i));
    const evaluation = assessTrend(rising(values), 'distinct_foods', W30);
    expect(evaluation.outcome).toBe('passes_decided_gates');
    if (evaluation.outcome !== 'passes_decided_gates') return;
    expect(evaluation.assessment.slopePerDay).toBeCloseTo(1, 12);
    expect(evaluation.assessment.sampleSize).toBe(20);
  });

  it('rejects fewer than 14 observed days, however clean the line', () => {
    const values = Array.from({ length: 30 }, (_, i) => (i < 13 ? i : null));
    expect(assessTrend(rising(values), 'distinct_foods', W30)).toMatchObject({
      outcome: 'rejected',
      reason: 'insufficient_sample',
      sampleSize: 13,
    });
  });

  it('rejects a flat series (no variance) and a poor fit', () => {
    expect(assessTrend(rising(Array.from({ length: 30 }, () => 5)), 'distinct_foods', W30)).toMatchObject({
      outcome: 'rejected',
      reason: 'no_variance',
    });
    const zigzag = Array.from({ length: 30 }, (_, i) => (i % 2 ? 9 : 3));
    expect(assessTrend(rising(zigzag), 'distinct_foods', W30)).toMatchObject({ outcome: 'rejected', reason: 'low_fit' });
  });

  it('skips missing and non-finite values rather than reading them as 0', () => {
    const values: Array<number | null> = Array.from({ length: 30 }, (_, i) => i);
    values[4] = Number.NaN;
    values[9] = Number.POSITIVE_INFINITY;
    values[14] = null;
    const evaluation = assessTrend(rising(values), 'distinct_foods', W30);
    expect(evaluation.outcome).toBe('passes_decided_gates');
    if (evaluation.outcome !== 'passes_decided_gates') return;
    expect(evaluation.assessment.sampleSize).toBe(27);
    expect(evaluation.assessment.slopePerDay).toBeCloseTo(1, 12);
  });
});

// ── Noise (§9, D13) ────────────────────────────────────────────────────────────

describe('noise fixture (inferential detectors only — D13)', () => {
  /** Chosen before the fixture was first run, and never changed to make a test pass. */
  const CANONICAL_SEED = 20260930;
  const trendable = METRIC_KEYS.filter(isTrendable);

  it('finds no correlation, trend or timing structure in 30/45 days of independent noise', () => {
    const f30 = noiseDays(CANONICAL_SEED, W30.from, 30);
    const f45 = noiseDays(CANONICAL_SEED, W45.from, 45);

    for (const pair of READY_CORRELATION_PAIRS) {
      expect(evaluateCorrelation(f30, pair, W30).outcome).toBe('rejected');
    }
    for (const metric of trendable) {
      expect(assessTrend(f30, metric, W30).outcome).toBe('rejected');
    }
    for (const condition of APPROVED_TIMING_CONDITIONS) {
      expect(evaluateTiming(f45, condition, W45).outcome).toBe('rejected');
    }
    expect(runApprovedDetectors(f30, { correlation: W30 })).toEqual([]);
  });

  it('keeps each gate close to its theoretical false-positive rate across 1,000 seeded noise datasets', () => {
    // A single seed can pass by luck; the rate over many is the property that matters.
    // Correlation at n = 30, |r| ≥ 0.45 ⇒ p ≈ 0.013 per pair; trend R² ≥ 0.3 at n = 30 ⇒ p ≈ 0.002.
    const seeds = 1000;
    let correlations = 0;
    let trends = 0;
    let timings = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const f30 = noiseDays(seed, W30.from, 30);
      const f45 = noiseDays(seed, W45.from, 45);
      correlations += READY_CORRELATION_PAIRS.filter((pair) => evaluateCorrelation(f30, pair, W30).outcome === 'emitted').length;
      trends += trendable.filter((metric) => assessTrend(f30, metric, W30).outcome === 'passes_decided_gates').length;
      timings += APPROVED_TIMING_CONDITIONS.filter((c) => evaluateTiming(f45, c, W45).outcome === 'passes_gates').length;
    }
    expect(correlations / (seeds * READY_CORRELATION_PAIRS.length)).toBeLessThan(0.03);
    expect(trends / (seeds * trendable.length)).toBeLessThan(0.01);
    // Characterisation, not a target: the §3.3 gates (difference ≥ 0.25, p < 0.10) admit roughly
    // one noise dataset in eleven at ~22 days a group. Timing does not emit (D16), and this rate
    // is recorded for the decision that would unblock it.
    const timingRate = timings / seeds;
    expect(timingRate).toBeGreaterThan(0.05);
    expect(timingRate).toBeLessThan(0.13);
  });

  it('is reproducible: the same seed gives the same days', () => {
    expect(noiseDays(CANONICAL_SEED, W30.from, 30)).toEqual(noiseDays(CANONICAL_SEED, W30.from, 30));
    expect(noiseDays(CANONICAL_SEED, W30.from, 30)).not.toEqual(noiseDays(CANONICAL_SEED + 1, W30.from, 30));
  });
});
