import type { PATTERN_KINDS } from '../insights/pattern-evidence.js';
import { localDaysBetween } from '../lib/local-date.js';
import { DETECTOR_REGISTRY } from './registry.js';

/**
 * Ranking for serving (PATTERN_ENGINE_DECISIONS.md D10). Pure: patterns and an explicit
 * reference date in, an order out — no clock, no database, nothing persisted.
 *
 * ```
 * score   = 0.50 · strength + 0.30 · recency + 0.20 · actionability
 * recency = 2 ^ (−ageDays / 14),  ageDays = days from windowEnd to the reference date
 * order   = score DESC, strength DESC, lastDetectedAt DESC, key ASC
 * ```
 *
 * `score` is a serving order, not a statistic: it never replaces strength, p-value, sample
 * size or coverage, and it is not rounded here. Recency reads `windowEnd` — how recent the
 * evidence is — not `lastDetectedAt`, which is only when that evidence was written.
 */

type PatternKind = (typeof PATTERN_KINDS)[number];

export const SCORE_WEIGHTS = { strength: 0.5, recency: 0.3, actionability: 0.2 } as const;
export const RECENCY_HALF_LIFE_DAYS = 14;

/**
 * 1 when the evidence ends on the reference date, halving every 14 days before it. A window
 * ending after the reference date (a clock disagreement, not a real case) counts as age 0,
 * so recency never exceeds 1.
 */
export function recency(windowEnd: string, referenceDate: string): number {
  const ageDays = Math.max(0, localDaysBetween(windowEnd, referenceDate));
  return 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** The family's serving actionability, or `null` where none is decided. */
export function actionabilityOf(kind: PatternKind): number | null {
  const registration = Object.values(DETECTOR_REGISTRY).find((entry) => entry.kinds.includes(kind));
  return registration?.actionability ?? null;
}

export interface Rankable {
  key: string;
  kind: PatternKind;
  /** Magnitude, 0..1 (D6). */
  strength: number;
  windowEnd: string;
  /** ISO timestamp. */
  lastDetectedAt: string;
}

/** The score of one pattern, or `null` when its kind has no actionability. */
export function scorePattern(pattern: Rankable, referenceDate: string): number | null {
  const actionability = actionabilityOf(pattern.kind);
  if (actionability === null) return null;
  return (
    SCORE_WEIGHTS.strength * pattern.strength +
    SCORE_WEIGHTS.recency * recency(pattern.windowEnd, referenceDate) +
    SCORE_WEIGHTS.actionability * actionability
  );
}

/** The canonical order: score DESC, strength DESC, lastDetectedAt DESC, key ASC. Nothing else. */
export function compareRanked(a: Rankable & { score: number }, b: Rankable & { score: number }): number {
  return (
    b.score - a.score ||
    b.strength - a.strength ||
    Date.parse(b.lastDetectedAt) - Date.parse(a.lastDetectedAt) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * Scores and orders patterns. A pattern whose kind has no decided actionability cannot be
 * scored and is left out rather than given an invented value; no such pattern can be stored
 * today, because only correlation emits.
 */
export function rankPatterns<T extends Rankable>(patterns: readonly T[], referenceDate: string): Array<T & { score: number }> {
  return patterns
    .flatMap((pattern) => {
      const score = scorePattern(pattern, referenceDate);
      return score === null ? [] : [{ ...pattern, score }];
    })
    .sort(compareRanked);
}
