import { z } from 'zod';

/**
 * The seam between the Pattern Engine and everything that talks about patterns.
 *
 * ## Why this is an interface and not an engine
 *
 * The engine is Phase 5 (`PATTERN_ENGINE.md`), and it does not exist yet. The weekly
 * story must not build a small one of its own to have something to say: a correlation
 * computed ad hoc inside a narration feature is exactly the "LLM-adjacent statistics"
 * `PATTERN_ENGINE.md` §1 was written to prevent. So the weekly story *consumes* patterns
 * through this contract, and today the only source says, honestly, that there is no
 * engine.
 *
 * ## Who owns the thresholds
 *
 * The engine. `n ≥ 10`, `|r| ≥ 0.45`, coverage ≥ 70% and `p < 0.10` are its gates, and
 * its verdict arrives here as `status`. This module does not re-check them — a second
 * copy of a statistical gate is a second place for it to drift. It does the part that
 * is a consumer's job: refuse anything malformed, take only `active` patterns, and rank
 * by the engine's own score.
 */

export const PATTERN_KINDS = ['correlation', 'trend', 'timing', 'frequency', 'streak'] as const;
export const PATTERN_DIRECTIONS = ['positive', 'negative', 'none'] as const;
export const PATTERN_STATUSES = ['candidate', 'active', 'stale', 'dismissed'] as const;

/** Three pattern cards is what `InsightsView` shows (PATTERN_ENGINE.md §4). */
export const MAX_STORY_PATTERNS = 3;

/**
 * One pattern as the engine reports it. Field names follow the `patterns` table in
 * `DATABASE_DESIGN.md` §3.7, plus the two things a narrator needs that a column name is
 * not: a human label for each metric, and the ranking score.
 *
 * Deliberately not `.strict()`: an engine may carry more (the chart series, timestamps)
 * and this consumer simply does not read it. What it does read, it requires.
 */
export const patternEvidenceSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(PATTERN_KINDS),
  subjectMetric: z.string().min(1).max(60),
  subjectLabel: z.string().min(1).max(80),
  objectMetric: z.string().min(1).max(60).nullable(),
  objectLabel: z.string().min(1).max(80).nullable(),
  direction: z.enum(PATTERN_DIRECTIONS),
  strength: z.number().min(-1).max(1),
  pValue: z.number().min(0).max(1).nullable(),
  sampleSize: z.number().int().min(1),
  windowDays: z.number().int().min(1),
  coverage: z.number().min(0).max(1),
  status: z.enum(PATTERN_STATUSES),
  /** The engine's ranking score (PATTERN_ENGINE.md §4). Ranking is its job, not ours. */
  score: z.number().min(0).max(1),
  /**
   * Required, and never model-authored. A pattern without its hedge is not shown
   * (API_DESIGN.md §14), and the weekly story attaches this text verbatim rather than
   * letting Claude paraphrase the one sentence that must not be softened.
   */
  caveat: z.string().trim().min(1).max(280),
});

export type PatternEvidence = z.infer<typeof patternEvidenceSchema>;

export interface PatternEvidenceSource {
  /**
   * Patterns relevant to a period. Returns `unknown[]` because this is a boundary: the
   * engine is another subsystem, and its output is validated here like any other input.
   *
   * `null` means **there is no engine**, which is different from an engine that found
   * nothing — the first is a limitation to disclose, the second is a result.
   */
  forPeriod(userId: string, period: { from: string; to: string }): Promise<readonly unknown[] | null>;
}

/** The only source until Phase 5 lands. It does not pretend to have looked. */
export const NO_PATTERN_ENGINE: PatternEvidenceSource = {
  async forPeriod() {
    return null;
  },
};

export type PatternSelectionStatus = 'unavailable' | 'none' | 'available';

export interface PatternSelection {
  status: PatternSelectionStatus;
  items: PatternEvidence[];
}

/**
 * The patterns a weekly story may mention: valid, `active`, ranked, capped.
 *
 * Anything that fails the schema is dropped rather than repaired — a pattern missing its
 * caveat or reporting a strength of 3 is not a pattern with a small problem, it is a
 * claim nobody can stand behind. A `candidate` is dropped because the engine has said it
 * has not earned the right to be shown; that includes every pattern below the sample
 * gate.
 */
export function selectPatternEvidence(candidates: readonly unknown[] | null): PatternSelection {
  if (candidates === null) return { status: 'unavailable', items: [] };

  const active = candidates.flatMap((candidate) => {
    const parsed = patternEvidenceSchema.safeParse(candidate);
    return parsed.success && parsed.data.status === 'active' ? [parsed.data] : [];
  });

  // Engine score first; more evidence breaks a tie; the id makes the order total, so the
  // same patterns always produce the same story context.
  active.sort(
    (a, b) =>
      b.score - a.score ||
      b.sampleSize - a.sampleSize ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const seen = new Set<string>();
  const items = active
    .filter((pattern) => {
      if (seen.has(pattern.id)) return false;
      seen.add(pattern.id);
      return true;
    })
    .slice(0, MAX_STORY_PATTERNS);

  return { status: items.length > 0 ? 'available' : 'none', items };
}
