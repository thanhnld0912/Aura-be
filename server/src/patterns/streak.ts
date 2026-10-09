import { addLocalDays } from '../lib/local-date.js';
import { coldStart } from './cold-start.js';
import { windowDates } from './coverage.js';
import type { DailyFeatures } from './metrics.js';

/**
 * The streak half of the frequency/streak family (PATTERN_ENGINE.md §3.4,
 * PATTERN_ENGINE_DECISIONS.md D7, D14, D16): runs of consecutive **logged** days.
 *
 * **This module assesses; it never emits.** A streak's gates are decided (D16), but what it
 * would become as a pattern is not: D10 leaves a `strength` in [0,1] and an `actionability`
 * value open for this kind — without them it cannot be scored or ranked — and the persisted
 * evidence shape (D6) is a subject/object series a run of dates does not fit. The registry
 * (`registry.ts`) keeps the family blocked. An assessment that clears the gates is only that.
 *
 * ## What is counted
 *
 * D14: "Streak (logging runs) — `daily_summaries` (observed days)". A day is in a run when it
 * was **observed** (§2.1: something was logged). Nothing else is counted — not meals, not a
 * metric being non-null — and no other streak is defined, so none is built.
 *
 * ## The rules
 *
 * - **Cold start (D16 §1):** at least 30 observed days in the 45-day window.
 * - **Minimum (D16 §3):** a run of at least 3 consecutive observed days.
 * - **Breaks (D16 §3):** an unobserved day breaks a run, and so does a day with no summary
 *   row. A missing day is never bridged and never counted as logged.
 * - **Calendar:** days are the user's own local dates, as `daily_summaries` stores them, so a
 *   run follows the person's calendar and never a server timezone (D11).
 * - **Window:** the 45-day detection window ending on the last closed day. A run already under
 *   way when the window opens is counted from the window's first day — the window is the
 *   analysis scope, not a claim that the run started there.
 *
 * Pure: day features in, an assessment out. No database, no clock, no wording.
 */

/** D16 §3. */
export const MIN_STREAK_DAYS = 3;

/** Deterministic identity (D6); the `streak:` prefix is what `chk_pattern_key_kind` requires. */
export const LOGGING_STREAK_KEY = 'streak:logged_days';

export interface StreakRun {
  /** Consecutive observed days. */
  length: number;
  /** First and last day of the run, inclusive. */
  from: string;
  to: string;
}

export interface StreakAssessment {
  kind: 'streak';
  key: typeof LOGGING_STREAK_KEY;
  /**
   * The run ending on the window's last day — the last closed day. `null` when that day was
   * not logged: there is no current run, which is not a run of length 0 waiting to grow.
   */
  currentRun: StreakRun | null;
  /**
   * The longest run in the window. On a tie, the **most recent** of the equal runs, so the
   * same days always produce the same run; the length — the gated fact — is the same either way.
   */
  longestRun: StreakRun;
  /** Observed days in the window (the cold-start count). */
  observedDays: number;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  /** The dates of the longest run, oldest first — exactly the days the claim rests on. */
  evidence: string[];
}

export type StreakRejection =
  /** Fewer than 30 observed days in the 45-day window (D16 §1). */
  | 'cold_start'
  /** No run reaches MIN_STREAK_DAYS. */
  | 'no_streak';

export type StreakEvaluation =
  | { outcome: 'passes_decided_gates'; assessment: StreakAssessment }
  | {
      outcome: 'rejected';
      key: typeof LOGGING_STREAK_KEY;
      reason: StreakRejection;
      observedDays: number;
      /** The longest run found, 0 when nothing was logged. */
      longestRunLength: number;
    };

/** Maximal runs of consecutive dates, oldest first. Expects dates sorted ascending. */
function runsOf(observedDates: readonly string[]): StreakRun[] {
  const runs: StreakRun[] = [];
  for (const date of observedDates) {
    const last = runs.at(-1);
    if (last && addLocalDays(last.to, 1) === date) {
      last.to = date;
      last.length += 1;
    } else {
      runs.push({ length: 1, from: date, to: date });
    }
  }
  return runs;
}

/** The logging streak over the 45-day window ending on `windowEnd`, the last closed day. */
export function assessStreak(features: readonly DailyFeatures[], windowEnd: string): StreakEvaluation {
  const gate = coldStart(features, windowEnd);
  const runs = runsOf(gate.observedDates);

  // Most recent wins a tie: `>=` lets a later run of equal length replace an earlier one.
  let longest: StreakRun | null = null;
  for (const run of runs) if (!longest || run.length >= longest.length) longest = run;

  const rejected = (reason: StreakRejection): StreakEvaluation => ({
    outcome: 'rejected',
    key: LOGGING_STREAK_KEY,
    reason,
    observedDays: gate.observedDays,
    longestRunLength: longest?.length ?? 0,
  });

  if (!gate.passes) return rejected('cold_start');
  if (!longest || longest.length < MIN_STREAK_DAYS) return rejected('no_streak');

  const last = runs.at(-1)!;
  return {
    outcome: 'passes_decided_gates',
    assessment: {
      kind: 'streak',
      key: LOGGING_STREAK_KEY,
      currentRun: last.to === gate.window.to ? { ...last } : null,
      longestRun: { ...longest },
      observedDays: gate.observedDays,
      windowDays: windowDates(gate.window).length,
      windowStart: gate.window.from,
      windowEnd: gate.window.to,
      evidence: windowDates({ from: longest.from, to: longest.to }),
    },
  };
}
