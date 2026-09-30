import { LOCAL_DATE_PATTERN, addLocalDays } from '../lib/local-date.js';
import type { DailyFeatures, MetricKey } from './metrics.js';

/**
 * The data contract detectors consume: a metric laid out over **every calendar day** of an
 * analysis window, and one definition of coverage (PATTERN_ENGINE.md §2.2).
 *
 * `daily_summaries` only has rows for days on which something was written, so counting
 * rows would call a window with 20 logged days out of 30 "fully covered". Here the
 * denominator is always the number of days in the window, and a day with no row, an
 * unobserved row, or a null value is a gap in the series, never a 0.
 *
 * No gate is applied here. The ≥ 70% threshold belongs to the correlation detector
 * (§3.1), which is not built yet; this module only measures.
 */

/** Inclusive, in the user's calendar. */
export interface AnalysisWindow {
  from: string;
  to: string;
}

export interface SeriesPoint {
  localDate: string;
  value: number | null;
}

export interface MetricSeries {
  metric: MetricKey;
  window: AnalysisWindow;
  /** One point per calendar day, oldest first — gaps included. */
  points: SeriesPoint[];
}

export interface Coverage {
  /** Days in the window. The denominator, always. */
  days: number;
  /** Days on which every metric asked about has a value. */
  observed: number;
  /** `observed / days`, unrounded. A window always has at least one day. */
  rate: number;
}

/** Every date from `from` to `to`, inclusive. */
export function windowDates(window: AnalysisWindow): string[] {
  const { from, to } = window;
  if (!LOCAL_DATE_PATTERN.test(from) || !LOCAL_DATE_PATTERN.test(to)) {
    throw new Error(`not a local date window: ${from}..${to}`);
  }
  if (from > to) throw new Error(`window ends before it starts: ${from}..${to}`);
  const dates: string[] = [];
  for (let date = from; date <= to; date = addLocalDays(date, 1)) dates.push(date);
  return dates;
}

/** The window of `days` calendar days ending on `to`, inclusive. */
export function windowEnding(to: string, days: number): AnalysisWindow {
  if (!Number.isInteger(days) || days < 1) throw new Error(`window must span at least one day: ${days}`);
  return { from: addLocalDays(to, -(days - 1)), to };
}

/**
 * One metric over the window. Days without a row are gaps; so are rows outside the window,
 * which are ignored. Two rows for the same date would be a broken unique index, so it throws.
 */
export function seriesFor(
  features: readonly DailyFeatures[],
  metric: MetricKey,
  window: AnalysisWindow,
): MetricSeries {
  const byDate = new Map<string, DailyFeatures>();
  for (const day of features) {
    if (byDate.has(day.localDate)) throw new Error(`two summaries for ${day.localDate}`);
    byDate.set(day.localDate, day);
  }
  return {
    metric,
    window,
    points: windowDates(window).map((localDate) => ({
      localDate,
      value: byDate.get(localDate)?.values[metric] ?? null,
    })),
  };
}

/**
 * Coverage of one or more series over the same window: the share of the window's days on
 * which **all** of them have a value. For a correlation pair this is "both metrics present"
 * (§3.1); for a single series it is simply how much of the window it covers.
 */
export function coverage(...series: readonly MetricSeries[]): Coverage {
  const [first] = series;
  if (!first) throw new Error('coverage needs at least one series');
  for (const other of series) {
    if (other.window.from !== first.window.from || other.window.to !== first.window.to) {
      throw new Error('coverage compares series over the same window only');
    }
  }

  const days = first.points.length;
  let observed = 0;
  for (let i = 0; i < days; i++) {
    if (series.every((one) => one.points[i]!.value !== null)) observed++;
  }
  return { days, observed, rate: observed / days };
}
