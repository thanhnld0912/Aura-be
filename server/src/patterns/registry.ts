import type { PATTERN_KINDS } from '../insights/pattern-evidence.js';
import {
  CORRELATION_WINDOW_DAYS,
  READY_CORRELATION_PAIRS,
  correlationKey,
  detectCorrelations,
  type CorrelationPair,
  type CorrelationResult,
} from './correlation.js';
import { COLD_START_WINDOW_DAYS } from './cold-start.js';
import { windowEnding, type AnalysisWindow } from './coverage.js';
import type { DailyFeatures, MetricKey } from './metrics.js';
import { detectStreak, type StreakResult } from './streak.js';

/**
 * Which detectors may turn a statistic into a pattern — the single place that decides.
 *
 * Every detector family of PATTERN_ENGINE.md §3 is listed with its status. Only a family
 * marked `emits: true` is ever run by `runApprovedDetectors`; the others may have their
 * evaluation built and tested (`timing.ts`, `trend.ts`), but nothing they compute can leave
 * the detector layer until the decision that blocks them is made. Within correlation, only
 * the approved pairs run — an arbitrary pair of metrics cannot become a pattern by accident.
 */

type PatternKind = (typeof PATTERN_KINDS)[number];

export type DetectorFamily = 'correlation' | 'timing' | 'trend' | 'frequency_streak';

export interface DetectorRegistration {
  family: DetectorFamily;
  /** The pattern kinds the family produces (D7). */
  kinds: readonly PatternKind[];
  /** Whether results may leave the detector layer — true when any of its kinds may. */
  emits: boolean;
  /**
   * The kinds whose results may leave the detector layer. A family can emit some kinds and
   * not others: frequency/streak emits `streak` while frequency is not built (D7).
   */
  emittingKinds: readonly PatternKind[];
  /** What must be decided or built before its blocked kinds may emit; empty when none is blocked. */
  blockedBy: readonly string[];
  /** Where its gates are specified. */
  spec: string;
  /**
   * Stored with every pattern the family produces (`patterns.detector_version`). Bump it
   * when the family's gates, window, pairs or metric definitions change, so a persisted
   * pattern says which definition produced it.
   */
  version: string;
  /**
   * Serving metadata for ranking (`ranking.ts`, D10): how directly a person can act on what
   * this family reports, 0..1. A heuristic, not a statistic and not a confidence. `null` where
   * no value is decided — a pattern of that family cannot be ranked, and none can be stored
   * while the family is blocked. Never persisted with a pattern.
   */
  actionability: number | null;
}

export const DETECTOR_REGISTRY: Readonly<Record<DetectorFamily, DetectorRegistration>> = {
  correlation: {
    family: 'correlation',
    version: 'correlation@1',
    actionability: 0.7,
    kinds: ['correlation'],
    emits: true,
    emittingKinds: ['correlation'],
    blockedBy: [],
    spec: 'PATTERN_ENGINE.md §3.1; PATTERN_ENGINE_DECISIONS.md D8 — approved pairs only',
  },
  timing: {
    family: 'timing',
    version: 'timing@1',
    actionability: null,
    kinds: ['timing'],
    emits: false,
    emittingKinds: [],
    blockedBy: [
      'D16 — the cold-start gate (≥ 30 observed days in the 45-day window) is decided and built in cold-start.ts, but timing does not apply it yet',
      'D16 — noise: the §3.3 gates pass ≈ 9% of seeded pure-noise 45-day datasets (PATTERN_ENGINE.md §3)',
      'data — POST /api/workouts writes only completed sessions (no skip endpoint yet), so workout_completed is 1 or null in production, never 0 — no contrast for timing to measure (D3)',
    ],
    spec: 'PATTERN_ENGINE.md §3.3; evaluation in timing.ts',
  },
  trend: {
    family: 'trend',
    version: 'trend@1',
    actionability: null,
    kinds: ['trend'],
    emits: false,
    emittingKinds: [],
    blockedBy: [
      'D9 — the minimum practical slope ("materially different from zero") is open',
      'D16 — the cold-start gate (≥ 30 observed days in the 45-day window) is decided and built in cold-start.ts, but trend does not apply it yet',
    ],
    spec: 'PATTERN_ENGINE.md §3.2; PATTERN_ENGINE_DECISIONS.md D9; assessment in trend.ts',
  },
  frequency_streak: {
    family: 'frequency_streak',
    version: 'frequency_streak@1',
    actionability: null,
    kinds: ['frequency', 'streak'],
    // The logging streak emits (D6, D10 S1/S3); frequency stays blocked. Actionability stays
    // null: a streak is served as a fact beside the ranked list, never scored (D10 S3).
    emits: true,
    emittingKinds: ['streak'],
    blockedBy: [
      'frequency — not built: no counting unit for most-repeated foods, no emission rule for the weekday/weekend split, and skip reasons are data-blocked (D3)',
      'frequency — no strength in [0,1], no actionability and no stored evidence shape are decided (D10, D6)',
    ],
    spec: 'PATTERN_ENGINE.md §3.4; PATTERN_ENGINE_DECISIONS.md D6, D7, D10, D14, D16 — logging streak in streak.ts; frequency not built',
  },
};

/**
 * Kinds served as facts beside the ranked list rather than inside it (D10 S3): the logging
 * streak says what happened, it is not an insight competing for attention, so it has no
 * actionability and is never scored.
 */
export const FACTUAL_KINDS: readonly PatternKind[] = ['streak'];

export function isFactualKind(kind: PatternKind): boolean {
  return FACTUAL_KINDS.includes(kind);
}

/** Whether results of this kind may leave the detector layer. */
export function kindEmits(kind: PatternKind): boolean {
  return Object.values(DETECTOR_REGISTRY).some((entry) => entry.emittingKinds.includes(kind));
}

/** The families allowed to emit, in registry order. */
export function emittingFamilies(): DetectorFamily[] {
  return (Object.keys(DETECTOR_REGISTRY) as DetectorFamily[]).filter((family) => DETECTOR_REGISTRY[family].emits);
}

/**
 * The approved pair for two metrics, in its canonical orientation — or `null` when the pair
 * is not approved. Either order finds the same pair (D8), so no reversed duplicate exists.
 */
export function approvedCorrelationPair(a: MetricKey, b: MetricKey): CorrelationPair | null {
  if (a === b) return null;
  const key = correlationKey(a, b);
  return READY_CORRELATION_PAIRS.find((pair) => correlationKey(pair.subject, pair.object) === key) ?? null;
}

/** A detector result that may leave the detector layer. Grows as families are unblocked. */
export type DetectorResult = CorrelationResult | StreakResult;

export interface DetectorWindows {
  correlation: AnalysisWindow;
  /** The D16 detection window, 45 days (`cold-start.ts`). */
  streak: AnalysisWindow;
}

/**
 * The window each emitting family analyses for a run ending on `windowEnd` — the last
 * closed day. Each family's own documented length; nothing here is a new window.
 */
export function detectorWindowsEnding(windowEnd: string): DetectorWindows {
  return {
    correlation: windowEnding(windowEnd, CORRELATION_WINDOW_DAYS),
    streak: windowEnding(windowEnd, COLD_START_WINDOW_DAYS),
  };
}

/** The days a run must read: from the earliest window start to the shared end. */
export function detectionRange(windows: DetectorWindows): AnalysisWindow {
  const all = Object.values(windows);
  return {
    from: all.map((window) => window.from).sort()[0]!,
    to: all.map((window) => window.to).sort().at(-1)!,
  };
}

/**
 * Runs every family allowed to emit, and nothing else. Blocked families are not called at
 * all, so a timing or trend signal in the data — however strong — produces no result here.
 */
export function runApprovedDetectors(features: readonly DailyFeatures[], windows: DetectorWindows): DetectorResult[] {
  const results: DetectorResult[] = [];
  for (const family of emittingFamilies()) {
    switch (family) {
      case 'correlation':
        results.push(...detectCorrelations(features, windows.correlation));
        break;
      case 'frequency_streak':
        // Streak only: frequency is not built (`emittingKinds`).
        results.push(...detectStreak(features, windows.streak));
        break;
      default:
        // A family marked as emitting without a runner here is a programming error.
        throw new Error(`detector family ${family} is marked as emitting but has no runner`);
    }
  }
  return results;
}
