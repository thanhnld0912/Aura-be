import type { PATTERN_KINDS } from '../insights/pattern-evidence.js';
import {
  CORRELATION_WINDOW_DAYS,
  READY_CORRELATION_PAIRS,
  correlationKey,
  detectCorrelations,
  type CorrelationPair,
  type CorrelationResult,
} from './correlation.js';
import { windowEnding, type AnalysisWindow } from './coverage.js';
import type { DailyFeatures, MetricKey } from './metrics.js';

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
  /** Whether results may leave the detector layer. */
  emits: boolean;
  /** What must be decided or built before it may emit; empty when it emits. */
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
    blockedBy: [],
    spec: 'PATTERN_ENGINE.md §3.1; PATTERN_ENGINE_DECISIONS.md D8 — approved pairs only',
  },
  timing: {
    family: 'timing',
    version: 'timing@1',
    actionability: null,
    kinds: ['timing'],
    emits: false,
    blockedBy: [
      'D16 — the cold-start gate (≥ 30 observed days in the 45-day window) is decided and built in cold-start.ts, but timing does not apply it yet',
      'D16 — noise: the §3.3 gates pass ≈ 9% of seeded pure-noise 45-day datasets (PATTERN_ENGINE.md §3)',
      'data — no endpoint writes workout_sessions, so workout_completed is null in production (D3)',
    ],
    spec: 'PATTERN_ENGINE.md §3.3; evaluation in timing.ts',
  },
  trend: {
    family: 'trend',
    version: 'trend@1',
    actionability: null,
    kinds: ['trend'],
    emits: false,
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
    emits: false,
    blockedBy: [
      'D10 — no strength in [0,1] and no actionability value is decided for frequency or streak, so neither can be scored or ranked',
      'D6 — persisted evidence is a subject/object series and toDetectedPattern accepts correlations only; a run of dates or a count distribution has no stored shape',
      'frequency — not built: no counting unit for most-repeated foods, no emission rule for the weekday/weekend split, and skip reasons are data-blocked (D3)',
    ],
    spec: 'PATTERN_ENGINE.md §3.4; PATTERN_ENGINE_DECISIONS.md D7, D14, D16 — streak assessment in streak.ts; frequency not built',
  },
};

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
export type DetectorResult = CorrelationResult;

export interface DetectorWindows {
  correlation: AnalysisWindow;
}

/**
 * The window each emitting family analyses for a run ending on `windowEnd` — the last
 * closed day. Each family's own documented length; nothing here is a new window.
 */
export function detectorWindowsEnding(windowEnd: string): DetectorWindows {
  return { correlation: windowEnding(windowEnd, CORRELATION_WINDOW_DAYS) };
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
      default:
        // A family marked as emitting without a runner here is a programming error.
        throw new Error(`detector family ${family} is marked as emitting but has no runner`);
    }
  }
  return results;
}
