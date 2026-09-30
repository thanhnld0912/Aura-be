import { LOCAL_DATE_PATTERN, parseTimeToMinutes } from '../lib/local-date.js';
import { DAY_FACT_KEYS } from './day-facts.js';

/**
 * Layer 1 of the Pattern Engine: one `daily_summaries` row → one day of named metrics
 * (PATTERN_ENGINE.md §2).
 *
 * Pure and deterministic — no clock, no database, no AI. Detectors (not built yet) read
 * only what this module returns, so the rules that decide what a number *means* live in
 * exactly one place:
 *
 * - **Missing is not zero.** Every metric is `number | null`, and null means "the log does
 *   not say". Nothing here substitutes a 0 for an absence.
 * - **A day is observed only if something was logged.** A summary row can outlive its
 *   events (every event deleted), so an observation needs `events_logged > 0`; an
 *   unobserved day yields null for every metric.
 * - **Times are local wall-clock minutes.** The summary already stores `time` values in the
 *   user's timezone (`toLocalTime` in `lib/local-date.ts`); this layer only converts
 *   `HH:mm[:ss]` to minutes past midnight and never re-applies a timezone.
 */

/** How a metric's numbers behave — what a detector may and may not do with them. */
export type MetricScale =
  /** A count of rows in the log itself; 0 is a real measurement. */
  | 'count'
  /** 0 or 1. */
  | 'binary'
  /** A measured quantity (ml, minutes, hours, foods). */
  | 'amount'
  /** Minutes past local midnight — a clock reading, circular at 24 h. */
  | 'clock'
  /** An ordered category mapped to 1…n. */
  | 'ordinal'
  /** 0–100. */
  | 'percent';

/**
 * Whether a metric can hold data today.
 *
 * - `available` — derived from data the API can write.
 * - `no_write_path` — the derivation exists, but no endpoint writes its source table, so
 *   every value is null in practice.
 * - `undefined_definition` — no canonical document defines it; always null.
 */
export type MetricStatus = 'available' | 'no_write_path' | 'undefined_definition';

export interface MetricDefinition {
  /** The name PATTERN_ENGINE.md §2 uses. */
  key: MetricKey;
  /** A plain label for people — used later by narration and the chart. */
  label: string;
  unit: string;
  scale: MetricScale;
  status: MetricStatus;
  /** Where the value comes from, for anyone auditing a claim. */
  source: string;
  /** Present when a known ambiguity must be settled before a detector may use the metric. */
  unresolved?: string;
}

export const METRIC_KEYS = [
  'bedtime_min',
  'sleep_minutes',
  'first_meal_min',
  'last_meal_min',
  'breakfast_logged',
  'meals_logged',
  'vegetable_servings',
  'protein_servings',
  'distinct_foods',
  'workout_completed',
  'workout_planned_time',
  'plan_adherence_pct',
  'mood_score',
  'water_ml',
  'logging_gap_hours',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** Breakfast is "a meal before 10:30" (§2): strictly earlier than 630 minutes. */
export const BREAKFAST_BEFORE_MIN = 10 * 60 + 30;

/** `checkins.mood` ordinal, 1–4 (§2). */
export const MOOD_SCORE = { low: 1, okay: 2, good: 3, great: 4 } as const;
export type Mood = keyof typeof MOOD_SCORE;

export const METRICS: Record<MetricKey, MetricDefinition> = {
  bedtime_min: {
    key: 'bedtime_min',
    label: 'Bedtime',
    unit: 'minutes past midnight',
    scale: 'clock',
    status: 'available',
    source: 'earliest sleep event of the local day (daily_summaries.bedtime)',
    unresolved:
      'Overnight bedtimes: 23:30 is 1410 and 00:30 is 30 on this scale, and a sleep begun after midnight is filed ' +
      'under the next local day. How to compare bedtimes across midnight is not defined; no detector may treat ' +
      'this as a linear quantity until it is.',
  },
  sleep_minutes: {
    key: 'sleep_minutes',
    label: 'Sleep',
    unit: 'minutes',
    scale: 'amount',
    status: 'available',
    source: 'sum of sleep event durations (daily_summaries.sleep_minutes)',
  },
  first_meal_min: {
    key: 'first_meal_min',
    label: 'First meal',
    unit: 'minutes past midnight',
    scale: 'clock',
    status: 'available',
    source: 'earliest confirmed meal event (daily_summaries.first_meal_time)',
  },
  last_meal_min: {
    key: 'last_meal_min',
    label: 'Last meal',
    unit: 'minutes past midnight',
    scale: 'clock',
    status: 'available',
    source: 'latest confirmed meal event (daily_summaries.last_meal_time)',
  },
  breakfast_logged: {
    key: 'breakfast_logged',
    label: 'Breakfast logged',
    unit: '0/1',
    scale: 'binary',
    status: 'available',
    source: 'first meal earlier than 10:30',
    unresolved:
      'A day with other logs but no meal is left null here (unknown), not 0. Whether it should count as ' +
      '"breakfast not logged" is not defined.',
  },
  meals_logged: {
    key: 'meals_logged',
    label: 'Meals logged',
    unit: 'meals',
    scale: 'count',
    status: 'available',
    source: 'confirmed meal events (daily_summaries.meals_logged)',
  },
  vegetable_servings: {
    key: 'vegetable_servings',
    label: 'Vegetable servings',
    unit: 'servings',
    scale: 'amount',
    status: 'undefined_definition',
    source: 'none — no document defines a serving or which food categories count',
  },
  protein_servings: {
    key: 'protein_servings',
    label: 'Protein servings',
    unit: 'servings',
    scale: 'amount',
    status: 'undefined_definition',
    source: 'none — no document defines a serving or which food categories count',
  },
  distinct_foods: {
    key: 'distinct_foods',
    label: 'Distinct foods',
    unit: 'foods',
    scale: 'amount',
    status: 'available',
    source: 'distinct resolved foods in confirmed meals (daily_summaries.distinct_foods)',
  },
  workout_completed: {
    key: 'workout_completed',
    label: 'Workout completed',
    unit: '0/1',
    scale: 'binary',
    status: 'no_write_path',
    source: 'workout_sessions.status (daily_summaries.metrics.workout_completed)',
    unresolved: 'Whether a partial session counts as completed; partial-only days are null.',
  },
  workout_planned_time: {
    key: 'workout_planned_time',
    label: 'Planned workout time',
    unit: 'minutes past midnight',
    scale: 'clock',
    status: 'available',
    source: 'plan_items.planned_time for a workout (daily_summaries.metrics.workout_planned_time)',
    unresolved: 'Days with several planned workouts are null.',
  },
  plan_adherence_pct: {
    key: 'plan_adherence_pct',
    label: 'Plan adherence',
    unit: '%',
    scale: 'percent',
    status: 'available',
    source: 'reconciliation: happened / resolved plan items (daily_summaries.plan_adherence_pct)',
  },
  mood_score: {
    key: 'mood_score',
    label: 'Mood',
    unit: '1–4',
    scale: 'ordinal',
    status: 'available',
    source: 'check-in mood: low 1, okay 2, good 3, great 4 (daily_summaries.mood)',
  },
  water_ml: {
    key: 'water_ml',
    label: 'Water',
    unit: 'ml',
    scale: 'amount',
    status: 'available',
    source: 'sum of ml on water events (daily_summaries.water_ml)',
  },
  logging_gap_hours: {
    key: 'logging_gap_hours',
    label: 'Longest logging gap',
    unit: 'hours',
    scale: 'amount',
    status: 'available',
    source: 'longest interval between consecutive events of the day (daily_summaries.metrics.logging_gap_hours)',
  },
};

/** The columns of `daily_summaries` this layer reads — nothing else is needed. */
export interface SummarySnapshot {
  localDate: string;
  eventsLogged: number;
  mealsLogged: number;
  vegetableServings: number | null;
  proteinServings: number | null;
  distinctFoods: number | null;
  /** Postgres `numeric` arrives as a string. */
  waterMl: string | null;
  sleepMinutes: number | null;
  firstMealTime: string | null;
  lastMealTime: string | null;
  bedtime: string | null;
  planAdherencePct: string | null;
  mood: Mood | null;
  metrics: Record<string, number | string | null> | null;
}

export interface DailyFeatures {
  localDate: string;
  /** False when nothing was logged: every value is then null. */
  observed: boolean;
  values: Record<MetricKey, number | null>;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$/;

/**
 * `'23:30'` / `'23:30:00'` → 1410 minutes past midnight; `null` stays `null`.
 *
 * A malformed value is a bug upstream, not a missing observation, so it throws rather than
 * quietly becoming null. Seconds are dropped — the summary stores minutes.
 */
export function clockMinutes(time: string | null): number | null {
  if (time === null) return null;
  if (!TIME_PATTERN.test(time)) throw new Error(`not a wall-clock time: ${time}`);
  return parseTimeToMinutes(time);
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`not a number: ${String(value)}`);
  return parsed;
}

const EMPTY: Record<MetricKey, null> = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<
  MetricKey,
  null
>;

/** One summary row → the day's metrics. */
export function extractDailyFeatures(row: SummarySnapshot): DailyFeatures {
  if (!LOCAL_DATE_PATTERN.test(row.localDate)) throw new Error(`not a local date: ${row.localDate}`);
  if (row.eventsLogged <= 0) return { localDate: row.localDate, observed: false, values: { ...EMPTY } };

  const bag = row.metrics ?? {};
  const firstMeal = clockMinutes(row.firstMealTime);
  const hadMeal = row.mealsLogged > 0;

  return {
    localDate: row.localDate,
    observed: true,
    values: {
      bedtime_min: clockMinutes(row.bedtime),
      sleep_minutes: row.sleepMinutes,
      first_meal_min: firstMeal,
      last_meal_min: clockMinutes(row.lastMealTime),
      breakfast_logged: hadMeal && firstMeal !== null ? (firstMeal < BREAKFAST_BEFORE_MIN ? 1 : 0) : null,
      meals_logged: row.mealsLogged,
      // Always null: see METRICS.vegetable_servings.status. The column is read anyway so a
      // value written by a later, documented rule flows through without touching this layer.
      vegetable_servings: row.vegetableServings,
      protein_servings: row.proteinServings,
      distinct_foods: row.distinctFoods,
      workout_completed: numberOrNull(bag[DAY_FACT_KEYS.workoutCompleted]),
      workout_planned_time: numberOrNull(bag[DAY_FACT_KEYS.workoutPlannedTime]),
      plan_adherence_pct: numberOrNull(row.planAdherencePct),
      mood_score: row.mood === null ? null : MOOD_SCORE[row.mood],
      water_ml: numberOrNull(row.waterMl),
      logging_gap_hours: numberOrNull(bag[DAY_FACT_KEYS.loggingGapHours]),
    },
  };
}
