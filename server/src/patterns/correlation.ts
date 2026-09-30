import type { PATTERN_DIRECTIONS } from '../insights/pattern-evidence.js';
import { coverage, seriesFor, windowDates, type AnalysisWindow, type MetricSeries } from './coverage.js';
import type { DailyFeatures, MetricKey } from './metrics.js';
import { pearsonCorrelation } from './statistics.js';

/**
 * The correlation detector (PATTERN_ENGINE.md §3.1), for the curated pairs that are ready
 * to run (PATTERN_ENGINE_DECISIONS.md D8).
 *
 * Pure: day metrics in, detector results out. It computes nothing statistical itself —
 * `pearsonCorrelation` does that — and it stores, ranks and narrates nothing. Its one job
 * is the gate: a pair becomes a result only when **every** documented condition holds.
 *
 * What a result says is "these two logged measures moved together (or oppositely) in this
 * window". Direction is the sign of r and nothing more; there is no causal reading and no
 * judgement of which way is better.
 */

// ── The gates (PATTERN_ENGINE.md §3.1) ─────────────────────────────────────────

/** Fewer days cannot support a claim about a person. */
export const MIN_CORRELATION_SAMPLE = 10;
/** Weaker is noise at this sample size. */
export const MIN_ABS_CORRELATION = 0.45;
/** Two-tailed, deliberately lenient, paired with hedged copy. */
export const MAX_CORRELATION_P_VALUE = 0.1;
/** Both metrics present on at least 70% of the window's days, as the fraction 7/10. */
const MIN_COVERAGE = { numerator: 7, denominator: 10 } as const;
/** The documented analysis window (§3.1). Callers may pass another, e.g. in tests. */
export const CORRELATION_WINDOW_DAYS = 30;

// ── The pairs (D8) ─────────────────────────────────────────────────────────────

export interface CorrelationPair {
  /** Display orientation: the first listing in PATTERN_ENGINE.md §3.1. Never changes r. */
  subject: MetricKey;
  object: MetricKey;
}

/**
 * The pairs that can run today. The other §3.1 pairs wait on open decisions or on data:
 * `bedtime_min ↔ breakfast_logged` (D1), `distinct_foods ↔ vegetable_servings` (D5), and
 * both workout pairs (no write path for `workout_sessions`, D3). The reversed duplicate
 * `plan_adherence_pct ↔ mood_score` is the same undirected test and is not listed (D8).
 */
export const READY_CORRELATION_PAIRS: readonly CorrelationPair[] = [
  { subject: 'mood_score', object: 'plan_adherence_pct' },
  { subject: 'logging_gap_hours', object: 'meals_logged' },
];

/**
 * The pattern key of an undirected pair: kind, then the two metric keys sorted
 * lexicographically (D6, D8). `A ↔ B` and `B ↔ A` share one key.
 */
export function correlationKey(a: MetricKey, b: MetricKey): string {
  if (a === b) throw new Error(`a metric cannot be correlated with itself: ${a}`);
  const [first, second] = [a, b].sort();
  return `correlation:${first}:${second}`;
}

// ── Result ─────────────────────────────────────────────────────────────────────

type PatternDirection = (typeof PATTERN_DIRECTIONS)[number];

export interface CorrelationEvidencePoint {
  localDate: string;
  subject: number;
  object: number;
}

/**
 * A detector result (D6 "DetectorResult"): everything a later persistence layer needs, and
 * nothing that belongs to lifecycle (status, score) or narration (labels, caveat, prose).
 */
export interface CorrelationResult {
  kind: 'correlation';
  key: string;
  subjectMetric: MetricKey;
  objectMetric: MetricKey;
  direction: Extract<PatternDirection, 'positive' | 'negative'>;
  /** Pearson's r, −1..1. */
  strength: number;
  pValue: number;
  /** Complete pairs the statistic was computed from. */
  sampleSize: number;
  /** Days with both metrics / days in the window (PATTERN_ENGINE.md §2.2). */
  coverage: number;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  /** The exact pairs behind r, oldest first — what the chart draws (§6). */
  evidence: CorrelationEvidencePoint[];
}

export type CorrelationRejection =
  /** Fewer than MIN_CORRELATION_SAMPLE complete pairs. */
  | 'insufficient_sample'
  /** Both metrics on fewer than 70% of the window's days. */
  | 'low_coverage'
  /** r is undefined: a series did not vary (`subject_sd > 0`, and likewise the object). */
  | 'no_variance'
  /** |r| below MIN_ABS_CORRELATION. */
  | 'weak'
  /** p-value at or above MAX_CORRELATION_P_VALUE. */
  | 'not_significant';

export type CorrelationEvaluation =
  | { outcome: 'emitted'; result: CorrelationResult }
  | { outcome: 'rejected'; key: string; reason: CorrelationRejection; sampleSize: number; coverage: number };

/**
 * A non-finite value is not an observation. `extractDailyFeatures` never produces one, but
 * the detector does not rely on that: coverage and the paired sample must count the same days.
 */
function finiteOnly(series: MetricSeries): MetricSeries {
  return {
    ...series,
    points: series.points.map((point) =>
      point.value !== null && Number.isFinite(point.value) ? point : { ...point, value: null },
    ),
  };
}

/**
 * One pair over one window. Missing days stay missing: only days on which both metrics
 * have a value are paired, and that count is the `n` every gate uses.
 */
export function evaluateCorrelation(
  features: readonly DailyFeatures[],
  pair: CorrelationPair,
  window: AnalysisWindow,
): CorrelationEvaluation {
  const key = correlationKey(pair.subject, pair.object);
  const subject = finiteOnly(seriesFor(features, pair.subject, window));
  const object = finiteOnly(seriesFor(features, pair.object, window));
  const covered = coverage(subject, object);

  const evidence: CorrelationEvidencePoint[] = [];
  for (let i = 0; i < subject.points.length; i++) {
    const s = subject.points[i]!.value;
    const o = object.points[i]!.value;
    if (s !== null && o !== null) evidence.push({ localDate: subject.points[i]!.localDate, subject: s, object: o });
  }

  const rejected = (reason: CorrelationRejection, sampleSize = evidence.length): CorrelationEvaluation => ({
    outcome: 'rejected',
    key,
    reason,
    sampleSize,
    coverage: covered.rate,
  });

  if (evidence.length < MIN_CORRELATION_SAMPLE) return rejected('insufficient_sample');
  // Integer comparison, so 21/30 is exactly 70% rather than a float that might not be.
  if (covered.observed * MIN_COVERAGE.denominator < covered.days * MIN_COVERAGE.numerator) {
    return rejected('low_coverage');
  }

  const stats = pearsonCorrelation(
    evidence.map((point) => point.subject),
    evidence.map((point) => point.object),
  );
  if (!stats) return rejected('no_variance');
  if (stats.n !== evidence.length) throw new Error('paired sample and statistic disagree on n');
  if (Math.abs(stats.r) < MIN_ABS_CORRELATION) return rejected('weak', stats.n);
  if (!(stats.pValue < MAX_CORRELATION_P_VALUE)) return rejected('not_significant', stats.n);
  // |r| ≥ 0.45 rules out r = 0, so the sign is always defined here.

  return {
    outcome: 'emitted',
    result: {
      kind: 'correlation',
      key,
      subjectMetric: pair.subject,
      objectMetric: pair.object,
      direction: stats.r > 0 ? 'positive' : 'negative',
      strength: stats.r,
      pValue: stats.pValue,
      sampleSize: stats.n,
      coverage: covered.rate,
      windowDays: windowDates(window).length,
      windowStart: window.from,
      windowEnd: window.to,
      evidence,
    },
  };
}

/** Every ready pair over one window; only the pairs that pass every gate are returned. */
export function detectCorrelations(features: readonly DailyFeatures[], window: AnalysisWindow): CorrelationResult[] {
  return READY_CORRELATION_PAIRS.flatMap((pair) => {
    const evaluation = evaluateCorrelation(features, pair, window);
    return evaluation.outcome === 'emitted' ? [evaluation.result] : [];
  });
}
