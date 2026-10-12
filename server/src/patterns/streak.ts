import type { StreakEvidenceSnapshot } from '../database/schema/patterns.js';
import { addLocalDays } from '../lib/local-date.js';
import { COLD_START_WINDOW_DAYS, coldStart } from './cold-start.js';
import { windowDates, type AnalysisWindow } from './coverage.js';
import type { DailyFeatures } from './metrics.js';

/**
 * The streak half of the frequency/streak family (PATTERN_ENGINE.md §3.4,
 * PATTERN_ENGINE_DECISIONS.md D7, D14, D16): runs of consecutive **logged** days.
 *
 * `assessStreak` assesses; `detectStreak` turns an assessment that clears the gates into the
 * pattern the registry lets emit (D6, D10):
 *
 * - **Run:** the longest run in the window, the most recent on a tie (below). One pattern
 *   per user, `streak:logged_days` — never one per run.
 * - **Strength (D10 S1):** `run.length / 45`, unrounded, as `|r|` and coverage are. A
 *   descriptive normalised run length — not a p-value, a confidence, a probability or an
 *   effect. `pValue` is null: no test is run, so none is claimed.
 * - **Serving (D10 S3):** a fact, not a ranked insight — the family has no actionability and
 *   the streak never enters the ranked list (`selectPatternFacts`).
 * - **Evidence (D6):** the run's dates and the window context, `StreakEvidenceSnapshot`.
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

/** The metric a logging streak is about (`METRICS.logged_day`). */
export const STREAK_SUBJECT_METRIC = 'logged_day' as const;

/** A logging streak as it leaves the detector layer (`DetectorResult`, D6). */
export interface StreakResult {
  kind: 'streak';
  key: typeof LOGGING_STREAK_KEY;
  subjectMetric: typeof STREAK_SUBJECT_METRIC;
  objectMetric: null;
  /** A run has no sign. */
  direction: 'none';
  /** `run.length / windowDays` (D10 S1). */
  strength: number;
  /** No test is run (D6: null for frequency and streak). */
  pValue: null;
  /** The run's length — the days the claim rests on. */
  sampleSize: number;
  /** Observed days / window days (PATTERN_ENGINE.md §2.2). */
  coverage: number;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  evidence: StreakEvidenceSnapshot;
}

/** D10 S1: the run's share of the 45-day window. In [0, 1] for any run inside it. */
export function streakStrength(runLength: number, windowDays: number = COLD_START_WINDOW_DAYS): number {
  return runLength / windowDays;
}

/**
 * The logging streak over `window` as a detector result — none when the assessment is
 * rejected (cold start, or no run of MIN_STREAK_DAYS). The window must be the D16 detection
 * window: the gate's 30 observed days mean nothing over another length.
 */
export function detectStreak(features: readonly DailyFeatures[], window: AnalysisWindow): StreakResult[] {
  const days = windowDates(window).length;
  if (days !== COLD_START_WINDOW_DAYS) {
    throw new Error(`the logging streak reads a ${COLD_START_WINDOW_DAYS}-day window, not ${days}`);
  }
  const evaluation = assessStreak(features, window.to);
  if (evaluation.outcome !== 'passes_decided_gates') return [];

  const { longestRun: run, observedDays, windowStart, windowEnd } = evaluation.assessment;
  return [
    {
      kind: 'streak',
      key: LOGGING_STREAK_KEY,
      subjectMetric: STREAK_SUBJECT_METRIC,
      objectMetric: null,
      direction: 'none',
      strength: streakStrength(run.length),
      pValue: null,
      sampleSize: run.length,
      coverage: observedDays / COLD_START_WINDOW_DAYS,
      windowDays: COLD_START_WINDOW_DAYS,
      windowStart,
      windowEnd,
      evidence: {
        type: 'logged_days',
        run: { from: run.from, to: run.to, length: run.length },
        current: run.to === windowEnd,
        observedDays,
        windowDays: COLD_START_WINDOW_DAYS,
      },
    },
  ];
}
