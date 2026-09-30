import { windowDates, seriesFor, type AnalysisWindow } from './coverage.js';
import { METRICS, type DailyFeatures, type MetricKey, type MetricScale } from './metrics.js';
import { linearRegression } from './statistics.js';

/**
 * The trend detector's assessment (PATTERN_ENGINE.md §3.2, PATTERN_ENGINE_DECISIONS.md D9):
 * a linear fit of one metric against time, checked against the gates that are decided.
 *
 * **This module assesses; it never emits.** D9 leaves the practical-magnitude gate ("slope
 * materially different from zero") open, and §7 reserves trends for "30+" days of data whose
 * counting is open too (D16). So an assessment that clears `n ≥ 14` and `R² ≥ 0.3` is only
 * that — no minimum slope is applied here, because none has been decided, and no pattern is
 * produced. The registry (`registry.ts`) keeps trend blocked.
 *
 * Pure: day metrics in, an assessment out.
 */

// ── The decided gates (D9) ─────────────────────────────────────────────────────

export const MIN_TREND_SAMPLE = 14;
export const MIN_TREND_R_SQUARED = 0.3;

/**
 * Scales a straight line can describe. D9: "not `clock` until D1; not `binary`" — a clock
 * reading wraps at midnight, and a 0/1 series has no slope worth reading as a trend.
 */
const NON_TRENDABLE_SCALES: ReadonlySet<MetricScale> = new Set(['clock', 'binary']);

export function isTrendable(metric: MetricKey): boolean {
  const definition = METRICS[metric];
  return definition.status === 'available' && !NON_TRENDABLE_SCALES.has(definition.scale);
}

export interface TrendAssessment {
  metric: MetricKey;
  /** Change per calendar day, in the metric's own unit. */
  slopePerDay: number;
  intercept: number;
  rSquared: number;
  sampleSize: number;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
}

export type TrendRejection =
  /** The metric's scale cannot carry a linear trend, or the metric has no data source. */
  | 'not_trendable'
  /** Fewer than MIN_TREND_SAMPLE observed days. */
  | 'insufficient_sample'
  /** The metric did not change over the window: R² is 0/0. */
  | 'no_variance'
  /** R² below MIN_TREND_R_SQUARED. */
  | 'low_fit';

export type TrendEvaluation =
  | { outcome: 'passes_decided_gates'; assessment: TrendAssessment }
  | { outcome: 'rejected'; metric: MetricKey; reason: TrendRejection; sampleSize: number };

/**
 * One metric over one window. x is the **calendar-day offset** within the window, so a gap
 * leaves time where it was instead of pulling the remaining days together (D9); missing days
 * are skipped, never interpolated.
 */
export function assessTrend(
  features: readonly DailyFeatures[],
  metric: MetricKey,
  window: AnalysisWindow,
): TrendEvaluation {
  const days = windowDates(window);
  const y = seriesFor(features, metric, window).points.map((point) =>
    point.value !== null && Number.isFinite(point.value) ? point.value : null,
  );
  const observed = y.filter((value) => value !== null).length;
  const rejected = (reason: TrendRejection): TrendEvaluation => ({
    outcome: 'rejected',
    metric,
    reason,
    sampleSize: observed,
  });

  if (!isTrendable(metric)) return rejected('not_trendable');
  if (observed < MIN_TREND_SAMPLE) return rejected('insufficient_sample');

  const fit = linearRegression(
    days.map((_, offset) => offset),
    y,
  );
  if (!fit || fit.rSquared === null) return rejected('no_variance');
  if (fit.rSquared < MIN_TREND_R_SQUARED) return rejected('low_fit');

  return {
    outcome: 'passes_decided_gates',
    assessment: {
      metric,
      slopePerDay: fit.slope,
      intercept: fit.intercept,
      rSquared: fit.rSquared,
      sampleSize: fit.n,
      windowDays: days.length,
      windowStart: window.from,
      windowEnd: window.to,
    },
  };
}
