import { z } from 'zod';
import { LOCAL_DATE_PATTERN } from '../lib/local-date.js';
import { rankPatterns } from '../patterns/ranking.js';

/**
 * The seam between the Pattern Engine and everything that talks about patterns.
 *
 * ## Why this is an interface and not an engine
 *
 * The weekly story must not build a small engine of its own to have something to say: a
 * correlation computed ad hoc inside a narration feature is exactly the "LLM-adjacent
 * statistics" `PATTERN_ENGINE.md` §1 was written to prevent. So consumers read patterns
 * through `PatternEvidenceSource`. `NO_PATTERN_ENGINE` says, honestly, that there is no
 * engine; `PatternsEvidenceSource` (`modules/patterns/`) serves the persisted `patterns`.
 *
 * ## Who owns what
 *
 * The engine owns the gates (`n ≥ 10`, `|r| ≥ 0.45`, coverage ≥ 70%, `p < 0.10`) and its
 * verdict arrives as `status`; this module does not re-check them — a second copy of a
 * statistical gate is a second place for it to drift. Ranking is serving, not statistics:
 * `selectPatternEvidence` validates, keeps `active` patterns, and orders them with
 * `patterns/ranking.ts` against an explicit reference date (D10). Nothing here is persisted.
 */

export const PATTERN_KINDS = ['correlation', 'trend', 'timing', 'frequency', 'streak'] as const;
export const PATTERN_DIRECTIONS = ['positive', 'negative', 'none'] as const;
export const PATTERN_STATUSES = ['candidate', 'active', 'stale', 'dismissed'] as const;

/** Three pattern cards is what `InsightsView` shows (PATTERN_ENGINE.md §4). */
export const MAX_STORY_PATTERNS = 3;

const localDate = z.string().regex(LOCAL_DATE_PATTERN);
const instant = z.string().datetime({ offset: true });

/**
 * One pattern as the engine serves it: the persisted pattern (DATABASE_DESIGN.md §3.7)
 * plus what is derived at read time — a human label per metric and the caveat.
 *
 * Deliberately not `.strict()`: a source may carry more and this consumer does not read it.
 * What it does read, it requires.
 */
export const patternEvidenceSchema = z.object({
  id: z.string().min(1).max(100),
  /** The pattern's identity for its user — the detector's own key. */
  key: z.string().min(1).max(200),
  kind: z.enum(PATTERN_KINDS),
  subjectMetric: z.string().min(1).max(60),
  subjectLabel: z.string().min(1).max(80),
  objectMetric: z.string().min(1).max(60).nullable(),
  objectLabel: z.string().min(1).max(80).nullable(),
  /** The sign of the relationship. */
  direction: z.enum(PATTERN_DIRECTIONS),
  /** Magnitude only, 0..1 (D6). A signed value is malformed and is dropped. */
  strength: z.number().min(0).max(1),
  pValue: z.number().min(0).max(1).nullable(),
  sampleSize: z.number().int().min(1),
  coverage: z.number().min(0).max(1),
  windowStart: localDate,
  windowEnd: localDate,
  windowDays: z.number().int().min(1),
  /** The points behind the statistic — what a chart draws. */
  evidence: z.object({
    points: z.array(z.object({ localDate, subject: z.number(), object: z.number() })),
  }),
  detectorVersion: z.string().min(1).max(60),
  status: z.enum(PATTERN_STATUSES),
  firstDetectedAt: instant,
  lastDetectedAt: instant,
  statusChangedAt: instant,
  /**
   * Engine-owned text, attached verbatim and never model-authored. `null` where no copy
   * exists for the kind (D6); a null caveat does not hide a pattern.
   */
  caveat: z.string().trim().min(1).max(280).nullable(),
});

export type PatternEvidence = z.infer<typeof patternEvidenceSchema>;

/** A selected pattern with its serving score (D10). The score is never persisted. */
export type RankedPatternEvidence = PatternEvidence & { score: number };

export interface PatternPeriodRequest {
  from: string;
  to: string;
  /** The reader's local today — what "current" means for a source that holds current state. */
  today: string;
}

export interface PatternEvidenceSource {
  /**
   * Patterns relevant to a period. Returns `unknown[]` because this is a boundary: the
   * engine is another subsystem, and its output is validated here like any other input.
   *
   * `null` means **the source cannot say** — there is no engine, or the period is one it
   * holds no record of (a past week, for a source of current state). That is different from
   * `[]`, an engine that looked and found nothing: the first is a limitation to disclose,
   * the second is a result.
   */
  forPeriod(userId: string, request: PatternPeriodRequest): Promise<readonly unknown[] | null>;
}

/** The source while no detection run writes patterns. It does not pretend to have looked. */
export const NO_PATTERN_ENGINE: PatternEvidenceSource = {
  async forPeriod() {
    return null;
  },
};

export type PatternSelectionStatus = 'unavailable' | 'none' | 'available';

export interface PatternSelection {
  status: PatternSelectionStatus;
  items: RankedPatternEvidence[];
}

/**
 * The patterns a weekly story may mention: valid, `active`, ranked, capped.
 *
 * Anything that fails the schema is dropped rather than repaired — a pattern reporting a
 * strength of 3, or a signed strength, is not a pattern with a small problem, it is a claim
 * nobody can stand behind. A `candidate`, `stale` or `dismissed` pattern is not current and
 * is dropped. Order is the canonical D10 order (`rankPatterns`) against `referenceDate`;
 * one pattern per key.
 */
export function selectPatternEvidence(candidates: readonly unknown[] | null, referenceDate: string): PatternSelection {
  if (candidates === null) return { status: 'unavailable', items: [] };

  const active = candidates.flatMap((candidate) => {
    const parsed = patternEvidenceSchema.safeParse(candidate);
    return parsed.success && parsed.data.status === 'active' ? [parsed.data] : [];
  });

  const seen = new Set<string>();
  const items = rankPatterns(active, referenceDate)
    .filter((pattern) => {
      if (seen.has(pattern.key)) return false;
      seen.add(pattern.key);
      return true;
    })
    .slice(0, MAX_STORY_PATTERNS);

  return { status: items.length > 0 ? 'available' : 'none', items };
}
