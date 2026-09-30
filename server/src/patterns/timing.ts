import type { PATTERN_DIRECTIONS } from '../insights/pattern-evidence.js';
import { coverage, seriesFor, windowDates, type AnalysisWindow, type MetricSeries } from './coverage.js';
import type { DailyFeatures, MetricKey } from './metrics.js';
import { welchTTest } from './statistics.js';

/**
 * The timing / conditional detector's evaluation (PATTERN_ENGINE.md §3.3): split the days on
 * a documented condition and compare an outcome's rate between the two groups with Welch's
 * t-test.
 *
 * **This module evaluates; it does not emit.** A result that clears every §3.3 gate is a
 * *candidate*, and whether a candidate may become a pattern is the registry's call
 * (`registry.ts`). Timing is not allowed to emit yet: §7 reserves it for users with "30+"
 * days of data, and how those days are counted is open (PATTERN_ENGINE_DECISIONS.md D16).
 * Its inputs are also data-blocked in production — nothing writes `workout_sessions` (D3) —
 * so today it runs on fixtures only.
 *
 * Pure: day metrics in, an evaluation out. No database, no ranking, no wording.
 */

// ── The gates (PATTERN_ENGINE.md §3.3) ─────────────────────────────────────────

/** Days per group. */
export const MIN_TIMING_GROUP = 5;
/** Absolute difference between the two groups' rates. */
export const MIN_TIMING_RATE_DIFFERENCE = 0.25;
/** Welch, two-tailed. */
export const MAX_TIMING_P_VALUE = 0.1;
/** The documented look-back (§3.3: `INTERVAL '45 days'`). Callers may pass another. */
export const TIMING_WINDOW_DAYS = 45;

// ── The conditions ─────────────────────────────────────────────────────────────

export interface TimingCondition {
  /** The day metric that splits the days. */
  conditionMetric: MetricKey;
  /** A day is in the "at or after" group when `conditionMetric ≥ fromValue`. */
  fromValue: number;
  /** The outcome whose rate is compared between the groups. */
  outcomeMetric: MetricKey;
}

/**
 * The one documented condition: "do workouts planned after 18:00 complete less often?"
 * (§3.3, `workout_planned_time >= 1080`). Its inputs are settled by D3 (`workout_completed`)
 * and D4 (`workout_planned_time`, null when a day plans several workouts).
 */
export const APPROVED_TIMING_CONDITIONS: readonly TimingCondition[] = [
  { conditionMetric: 'workout_planned_time', fromValue: 18 * 60, outcomeMetric: 'workout_completed' },
];

/** `timing:<outcome>:<condition>_ge_<value>` — deterministic identity (D6). */
export function timingKey(condition: TimingCondition): string {
  return `timing:${condition.outcomeMetric}:${condition.conditionMetric}_ge_${condition.fromValue}`;
}

// ── Evaluation ─────────────────────────────────────────────────────────────────

type PatternDirection = (typeof PATTERN_DIRECTIONS)[number];

export interface TimingGroup {
  /** Days in the group with both the condition and the outcome observed. */
  n: number;
  /** Mean outcome in the group — a completion rate, for a 0/1 outcome. */
  rate: number;
}

export interface TimingEvidencePoint {
  localDate: string;
  condition: number;
  outcome: number;
}

/**
 * A candidate that cleared every §3.3 gate. Shaped like a detector result (D6) so the
 * registry can emit it unchanged once timing is allowed to, and carrying nothing that
 * belongs to lifecycle, ranking or narration.
 */
export interface TimingCandidate {
  kind: 'timing';
  key: string;
  /** The splitting metric. */
  subjectMetric: MetricKey;
  /** The outcome compared across the split. */
  objectMetric: MetricKey;
  /** Sign of (at-or-after rate − before rate). */
  direction: Extract<PatternDirection, 'positive' | 'negative'>;
  /** |rate difference| (at-or-after − before), 0..1 — the §3.3 effect size; the sign is `direction` (D6). */
  strength: number;
  pValue: number;
  sampleSize: number;
  /** Days with both metrics / days in the window (§2.2). Measured, not gated by §3.3. */
  coverage: number;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  condition: { metric: MetricKey; fromValue: number };
  groups: { atOrAfter: TimingGroup; before: TimingGroup };
  /** Every day that entered a group, oldest first. */
  evidence: TimingEvidencePoint[];
}

export type TimingRejection =
  /** A group has fewer than MIN_TIMING_GROUP days. */
  | 'insufficient_sample'
  /** Welch's t is undefined: both groups are constant (see `welchTTest`). */
  | 'no_variance'
  /** |rate difference| below MIN_TIMING_RATE_DIFFERENCE. */
  | 'weak'
  /** p-value at or above MAX_TIMING_P_VALUE. */
  | 'not_significant';

export type TimingEvaluation =
  | { outcome: 'passes_gates'; candidate: TimingCandidate }
  | {
      outcome: 'rejected';
      key: string;
      reason: TimingRejection;
      groups: { atOrAfter: { n: number }; before: { n: number } };
    };

const finiteOnly = (series: MetricSeries): MetricSeries => ({
  ...series,
  points: series.points.map((point) =>
    point.value !== null && Number.isFinite(point.value) ? point : { ...point, value: null },
  ),
});

const meanOf = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0) / values.length;

/**
 * One condition over one window. A day enters a group only when both the condition metric
 * and the outcome are observed: a planned workout with no session logged is unknown (D3),
 * not a 0, so it is left out rather than counted as "not completed".
 */
export function evaluateTiming(
  features: readonly DailyFeatures[],
  condition: TimingCondition,
  window: AnalysisWindow,
): TimingEvaluation {
  const key = timingKey(condition);
  const split = finiteOnly(seriesFor(features, condition.conditionMetric, window));
  const outcome = finiteOnly(seriesFor(features, condition.outcomeMetric, window));

  const evidence: TimingEvidencePoint[] = [];
  const atOrAfter: number[] = [];
  const before: number[] = [];
  for (let i = 0; i < split.points.length; i++) {
    const c = split.points[i]!.value;
    const o = outcome.points[i]!.value;
    if (c === null || o === null) continue;
    evidence.push({ localDate: split.points[i]!.localDate, condition: c, outcome: o });
    (c >= condition.fromValue ? atOrAfter : before).push(o);
  }

  const rejected = (reason: TimingRejection): TimingEvaluation => ({
    outcome: 'rejected',
    key,
    reason,
    groups: { atOrAfter: { n: atOrAfter.length }, before: { n: before.length } },
  });

  if (atOrAfter.length < MIN_TIMING_GROUP || before.length < MIN_TIMING_GROUP) return rejected('insufficient_sample');

  const test = welchTTest(atOrAfter, before);
  if (!test) return rejected('no_variance');

  const difference = meanOf(atOrAfter) - meanOf(before);
  if (Math.abs(difference) < MIN_TIMING_RATE_DIFFERENCE) return rejected('weak');
  if (!(test.pValue < MAX_TIMING_P_VALUE)) return rejected('not_significant');

  return {
    outcome: 'passes_gates',
    candidate: {
      kind: 'timing',
      key,
      subjectMetric: condition.conditionMetric,
      objectMetric: condition.outcomeMetric,
      direction: difference > 0 ? 'positive' : 'negative',
      strength: Math.abs(difference),
      pValue: test.pValue,
      sampleSize: evidence.length,
      coverage: coverage(split, outcome).rate,
      windowDays: windowDates(window).length,
      windowStart: window.from,
      windowEnd: window.to,
      condition: { metric: condition.conditionMetric, fromValue: condition.fromValue },
      groups: {
        atOrAfter: { n: atOrAfter.length, rate: meanOf(atOrAfter) },
        before: { n: before.length, rate: meanOf(before) },
      },
      evidence,
    },
  };
}
