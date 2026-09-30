/**
 * Day facts the Pattern Engine needs that `daily_summaries` has no column for, derived
 * from the source tables when a day is recomputed and stored in `daily_summaries.metrics`
 * (PATTERN_ENGINE.md §2 — "metrics jsonb holds anything added later without a migration").
 *
 * Pure: the repository fetches the raw rows, these functions decide what they mean. Every
 * rule returns `null` rather than a number when the rows do not settle the question —
 * **missing is not zero** (§2.1) — and where the documents leave a case open, the case is
 * left `null` and named in `UNRESOLVED` instead of being decided here.
 */

/** Keys written into `daily_summaries.metrics`. The recompute owns all of them. */
export const DAY_FACT_KEYS = {
  workoutCompleted: 'workout_completed',
  workoutPlannedTime: 'workout_planned_time',
  loggingGapHours: 'logging_gap_hours',
} as const;

export type DayFactKey = (typeof DAY_FACT_KEYS)[keyof typeof DAY_FACT_KEYS];
export type DayFacts = Record<DayFactKey, number | null>;

export type WorkoutStatus = 'completed' | 'partial' | 'skipped';

/**
 * `workout_completed` — "0/1 from `workout_sessions.status`" (§2).
 *
 * - any `completed` session → 1
 * - only `skipped` sessions → 0 (a logged skip is a measured "did not")
 * - no session → null (nothing logged is not "did not work out")
 * - a `partial` session with no `completed` one → null: whether partial counts as
 *   completed is not defined anywhere (see `UNRESOLVED.partialWorkout`)
 */
export function deriveWorkoutCompleted(statuses: readonly WorkoutStatus[]): number | null {
  if (statuses.length === 0) return null;
  if (statuses.includes('completed')) return 1;
  if (statuses.includes('partial')) return null;
  return 0;
}

/**
 * `workout_planned_time` — minutes past local midnight of the day's planned workout, from
 * `plan_items.planned_time` (§2, the timing detector's split in §3.3).
 *
 * One planned workout → its time. None → null. Several → null: §3.3 treats a day as having
 * *a* planned workout time, and which of several it means is not defined
 * (see `UNRESOLVED.multiplePlannedWorkouts`).
 */
export function deriveWorkoutPlannedTime(plannedMinutes: readonly number[]): number | null {
  return plannedMinutes.length === 1 ? plannedMinutes[0]! : null;
}

/**
 * `logging_gap_hours` — "max gap between logs" (§2): the longest interval between two
 * consecutive events on the same local day, in hours to two decimals.
 *
 * Fewer than two events have no gap between them, so the answer is null, not 0. Gaps
 * across midnight into the neighbouring day are not included — the metric is per day.
 */
export function deriveLoggingGapHours(instants: readonly Date[]): number | null {
  if (instants.length < 2) return null;
  const times = instants.map((instant) => instant.getTime()).sort((a, b) => a - b);
  let widest = 0;
  for (let i = 1; i < times.length; i++) widest = Math.max(widest, times[i]! - times[i - 1]!);
  return Math.round((widest / 3_600_000) * 100) / 100;
}

/**
 * `distinct_foods` — distinct resolved foods (`meal_items.food_id`) across the day's
 * confirmed meals. Items that never resolved to a food carry no identity to count, so a
 * day whose items are all unresolved is unknown (null), not "0 distinct foods".
 */
export function deriveDistinctFoods(distinctResolvedFoods: number): number | null {
  return distinctResolvedFoods > 0 ? distinctResolvedFoods : null;
}

/**
 * Decisions the canonical documents do not make. Each is left as `null` / unhandled in
 * this layer and must be settled before the detector that depends on it is written.
 */
export const UNRESOLVED = {
  partialWorkout: 'Whether a `partial` workout session counts as completed for `workout_completed`.',
  multiplePlannedWorkouts: 'Which planned time `workout_planned_time` takes when a day has several planned workouts.',
} as const;
