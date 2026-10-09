import { windowDates, windowEnding, type AnalysisWindow } from './coverage.js';
import type { DailyFeatures } from './metrics.js';

/**
 * The cold-start gate for the long-term detector families (PATTERN_ENGINE.md §7,
 * PATTERN_ENGINE_DECISIONS.md D16 §1): timing, trend, frequency and streak may say something
 * about a person only once **at least 30 days were observed within the 45-day detection window**.
 *
 * "Observed" is the day-level fact of §2.1 — something was logged that day
 * (`DailyFeatures.observed`, `events_logged > 0`). It is not 30 meals, not 30 workout days and
 * not 30 days on which some particular metric is non-null. A day with no summary row, and a
 * row whose events were all deleted, are both unobserved.
 *
 * The denominator is the window's calendar days, never the rows that exist (§2.2): a user
 * with 20 rows in 45 days has 20 observed days, not "all of them".
 *
 * Correlation keeps its own gates and does **not** take this one (D16 §4).
 *
 * Pure: day features in, a verdict out. The window is built here from its end date, so the
 * 30-day threshold can never be paired with a window of another length.
 */

/** The detection window the gate counts over (D16 §1). */
export const COLD_START_WINDOW_DAYS = 45;
/** Observed days required within that window (D16 §1). */
export const MIN_OBSERVED_DAYS = 30;

export interface ColdStart {
  /** The 45-day window ending on the last closed day. */
  window: AnalysisWindow;
  /** Calendar days in the window — the denominator, always 45. */
  days: number;
  /** Days in the window on which something was logged. */
  observedDays: number;
  /** The observed dates, oldest first. */
  observedDates: string[];
  passes: boolean;
}

/**
 * Observed days in a window. Rows outside it are ignored; two rows for one date would be a
 * broken unique index (`idx_daily_sum`), so that throws, as `seriesFor` does.
 */
export function observedDatesIn(features: readonly DailyFeatures[], window: AnalysisWindow): string[] {
  const observed = new Set<string>();
  const seen = new Set<string>();
  for (const day of features) {
    if (seen.has(day.localDate)) throw new Error(`two summaries for ${day.localDate}`);
    seen.add(day.localDate);
    if (day.observed) observed.add(day.localDate);
  }
  return windowDates(window).filter((localDate) => observed.has(localDate));
}

/** The D16 gate for the 45-day window ending on `windowEnd` (the last closed day). */
export function coldStart(features: readonly DailyFeatures[], windowEnd: string): ColdStart {
  const window = windowEnding(windowEnd, COLD_START_WINDOW_DAYS);
  const observedDates = observedDatesIn(features, window);
  return {
    window,
    days: COLD_START_WINDOW_DAYS,
    observedDays: observedDates.length,
    observedDates,
    passes: observedDates.length >= MIN_OBSERVED_DAYS,
  };
}
