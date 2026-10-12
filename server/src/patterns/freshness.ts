import { LOCAL_DATE_PATTERN, addLocalDays, localDaysBetween } from '../lib/local-date.js';

/**
 * How current a user's pattern evaluation is — the serving-side freshness policy.
 *
 * The persisted patterns are what the **last authoritative run** found
 * (`pattern_watermarks.evaluated_through`, D17). An `active` row says nothing about how long
 * ago that run was: if the nightly job stops, the rows stay `active` and would be served as
 * today's truth indefinitely. So a consumer asks how far the watermark is behind the reader's
 * **last closed local day** before it serves anything:
 *
 * ```
 * lag = lastClosedDay − evaluatedThrough        (lastClosedDay = the reader's today − 1)
 *
 * no watermark        never      no authoritative run has completed for this user
 * lag < 0             invalid    the watermark claims a day that is not closed yet
 * lag = 0             fresh      the last closed day itself was evaluated
 * lag = 1             delayed    last night's run has not reached this user yet
 * lag ≥ 2             stale      at least one nightly run was missed
 * ```
 *
 * ## Why one day
 *
 * The job runs once a night (02:15 `CRON_TIMEZONE`) and evaluates each user's yesterday. From
 * a user's local midnight until that run reaches them, their newest closed day is necessarily
 * unevaluated — a lag of exactly one day is the scheduler's normal cadence, for every timezone,
 * and is served. A lag of two means a whole nightly run did not happen for this user; that is
 * no longer cadence but an outage, and the evidence is withheld rather than presented as
 * current. One is therefore the smallest tolerance that does not blank every user for part of
 * every day.
 *
 * Both dates are local calendar dates in the **user's** timezone — the watermark is written
 * for the user's closed day and `today` is the reader's own today — so no server clock or
 * server timezone enters the comparison.
 *
 * Pure: two dates in, a verdict out. It changes no lifecycle state and moves no watermark;
 * whether stale evidence is *served* and whether a pattern is `stale` are separate questions.
 */

/** Closed days the watermark may trail the reader's last closed day and still be served. */
export const MAX_EVALUATION_LAG_DAYS = 1;

export type EvaluationFreshness = 'never' | 'invalid' | 'fresh' | 'delayed' | 'stale';

export interface EvaluationState {
  freshness: EvaluationFreshness;
  /** Closed days behind the reader's last closed day; `null` when there is no usable watermark. */
  lagDays: number | null;
}

const isLocalDate = (value: string): boolean => LOCAL_DATE_PATTERN.test(value) && addLocalDays(value, 0) === value;

/** The freshness of an evaluation that reached `evaluatedThrough`, for a reader whose local today is `today`. */
export function evaluationState(evaluatedThrough: string | null, today: string): EvaluationState {
  if (evaluatedThrough === null) return { freshness: 'never', lagDays: null };
  if (!isLocalDate(evaluatedThrough) || !isLocalDate(today)) return { freshness: 'invalid', lagDays: null };

  const lagDays = localDaysBetween(evaluatedThrough, addLocalDays(today, -1));
  // A watermark on the reader's today or later names a day that cannot have been closed.
  if (lagDays < 0) return { freshness: 'invalid', lagDays: null };
  if (lagDays === 0) return { freshness: 'fresh', lagDays };
  return { freshness: lagDays <= MAX_EVALUATION_LAG_DAYS ? 'delayed' : 'stale', lagDays };
}

/** Whether evidence from that evaluation may be served as current. */
export function isServable(state: EvaluationState): boolean {
  return state.freshness === 'fresh' || state.freshness === 'delayed';
}
