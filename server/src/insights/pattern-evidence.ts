import { z } from 'zod';
import { LOCAL_DATE_PATTERN, addLocalDays, localDaysBetween } from '../lib/local-date.js';
import { rankPatterns } from '../patterns/ranking.js';
import { isFactualKind } from '../patterns/registry.js';

/**
 * The seam between the Pattern Engine and everything that talks about patterns.
 *
 * ## Why this is an interface and not an engine
 *
 * The weekly story must not build a small engine of its own to have something to say: a
 * correlation computed ad hoc inside a narration feature is exactly the "LLM-adjacent
 * statistics" `PATTERN_ENGINE.md` §1 was written to prevent. So consumers read patterns
 * through `PatternEvidenceSource`. `NO_PATTERN_ENGINE` says, honestly, that there is no
 * engine; `PatternsEvidenceSource` (`modules/patterns/`) serves the persisted `patterns`,
 * and only while the evaluation behind them is current (`patterns/freshness.ts`). Which of
 * the two an API process uses is `PATTERN_ENGINE_ENABLED`, off by default.
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

/** A real calendar date in canonical form — `2026-02-30` matches the pattern but is not one. */
const canonicalLocalDate = localDate.refine((value) => addLocalDays(value, 0) === value, 'not a calendar date');

/** The logging streak's window: the D16 detection window (`cold-start.ts`). */
export const STREAK_WINDOW_DAYS = 45;

/** Correlation evidence (D6): the points behind the statistic. Unchanged since 5.3A. */
export const correlationEvidenceSchema = z.object({
  points: z.array(z.object({ localDate, subject: z.number(), object: z.number() })),
});

/**
 * Logging-streak evidence (D6): the run of consecutive logged days the claim rests on, and
 * the window context needed to reproduce it. Dates only — nothing about what was logged.
 * Checks what the shape alone can check; that the run lies inside the pattern's own window
 * is checked against the pattern (`patternEvidenceSchema`) and in `toDetectedPattern`.
 */
export const streakEvidenceSchema = z
  .object({
    type: z.literal('logged_days'),
    run: z.object({ from: canonicalLocalDate, to: canonicalLocalDate, length: z.number().int().min(1) }).strict(),
    current: z.boolean(),
    observedDays: z.number().int().min(0).max(STREAK_WINDOW_DAYS),
    windowDays: z.literal(STREAK_WINDOW_DAYS),
  })
  .strict()
  .superRefine((evidence, context) => {
    const { from, to, length } = evidence.run;
    if (to < from) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['run', 'to'], message: 'the run ends before it starts' });
      return;
    }
    if (length !== localDaysBetween(from, to) + 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['run', 'length'], message: 'length is not the days from..to' });
    }
    // Every day of the run is a logged day of the window.
    if (length > evidence.observedDays) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['observedDays'], message: 'fewer observed days than the run' });
    }
  });

export const patternEvidenceSnapshotSchema = z.union([correlationEvidenceSchema, streakEvidenceSchema]);

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
  /** Per kind (D6): the points behind a correlation, the run behind a streak. */
  evidence: patternEvidenceSnapshotSchema,
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
}).superRefine((pattern, context) => {
  const fail = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message });
  const evidence = pattern.evidence;
  if (pattern.kind !== 'streak') {
    if (!('points' in evidence)) fail(`a ${pattern.kind} pattern carries a points series`);
    return;
  }
  if (!('type' in evidence)) return fail('a streak pattern carries a run of logged days');
  // The run is inside the pattern's own window, and the row's figures are the run's.
  if (evidence.run.from < pattern.windowStart || evidence.run.to > pattern.windowEnd) fail('the run lies outside the window');
  if (pattern.windowDays !== evidence.windowDays) fail('windowDays does not match the evidence');
  if (pattern.sampleSize !== evidence.run.length) fail('sampleSize is not the run length');
  if (evidence.current !== (evidence.run.to === pattern.windowEnd)) fail('current does not match where the run ends');
  if (pattern.pValue !== null) fail('a streak has no p-value');
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

/**
 * Why a source cannot say what patterns a period holds. Each is a different statement, and
 * none of them is "no pattern was found":
 *
 * - `no_engine` — patterns are not served at all (the consumer is off).
 * - `period_not_current` — the source holds current state and the period is a past one.
 * - `not_evaluated` — no authoritative detection run has completed for this user.
 * - `evaluation_stale` — the last one is too old to be presented as current.
 * - `evaluation_invalid` — the stored evaluation state cannot be trusted (a watermark that
 *   names a day not closed yet, or evidence newer than the watermark).
 * - `source_failed` — the source threw while reading. Never produced by a source itself:
 *   the consumer records it when a read fails (`InsightsService`), so a failure is not
 *   mistaken for any of the states above — least of all for an evaluation that found nothing.
 */
export const PATTERN_UNAVAILABLE_REASONS = [
  'no_engine',
  'period_not_current',
  'not_evaluated',
  'evaluation_stale',
  'evaluation_invalid',
  'source_failed',
] as const;

export type PatternUnavailableReason = (typeof PATTERN_UNAVAILABLE_REASONS)[number];

/** "Cannot say", with the reason. */
export interface PatternsUnavailable {
  unavailable: PatternUnavailableReason;
}

export type PatternEvidenceAnswer = readonly unknown[] | PatternsUnavailable | null;

export interface PatternEvidenceSource {
  /**
   * Patterns relevant to a period. Returns `unknown[]` because this is a boundary: the
   * engine is another subsystem, and its output is validated here like any other input.
   *
   * An array — `[]` included — is a **result**: an evaluation current enough to speak for
   * the period looked, and this is what it found. Anything else means **the source cannot
   * say**: `{ unavailable: reason }`, or a bare `null`, which reads as `no_engine`. That is
   * a limitation to disclose, never a result — a source must not answer `[]` unless an
   * evaluation actually stands behind it.
   */
  forPeriod(userId: string, request: PatternPeriodRequest): Promise<PatternEvidenceAnswer>;
}

/**
 * A source's answer, split into what the selectors read (`candidates`, `null` when it
 * cannot say) and why it cannot. Anything that is neither an array nor a known reason is
 * treated as `no_engine`: an answer this boundary does not understand is not a result.
 */
export function readPatternAnswer(answer: PatternEvidenceAnswer): {
  candidates: readonly unknown[] | null;
  unavailable: PatternUnavailableReason | null;
} {
  if (Array.isArray(answer)) return { candidates: answer as readonly unknown[], unavailable: null };
  const reason = answer !== null && typeof answer === 'object' && 'unavailable' in answer ? answer.unavailable : null;
  return {
    candidates: null,
    unavailable: (PATTERN_UNAVAILABLE_REASONS as readonly unknown[]).includes(reason)
      ? (reason as PatternUnavailableReason)
      : 'no_engine',
  };
}

/**
 * The source while patterns are not served (`PATTERN_ENGINE_ENABLED` off, the default). It
 * reads nothing and does not pretend to have looked.
 */
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

  // Factual kinds (a logging streak) are served by `selectPatternFacts`, never ranked (D10 S3).
  const active = activePatterns(candidates).filter((pattern) => !isFactualKind(pattern.kind));

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

/** Valid, `active` patterns; anything malformed or not current is dropped, never repaired. */
function activePatterns(candidates: readonly unknown[]): PatternEvidence[] {
  return candidates.flatMap((candidate) => {
    const parsed = patternEvidenceSchema.safeParse(candidate);
    return parsed.success && parsed.data.status === 'active' ? [parsed.data] : [];
  });
}

export interface PatternFactSelection {
  status: PatternSelectionStatus;
  items: PatternEvidence[];
}

/**
 * The factual patterns — today, the logging streak (D10 S3): served beside the ranked list,
 * never inside it. A fact is not scored, so it is neither capped by `MAX_STORY_PATTERNS` nor
 * ordered by D10; the order is the key, so the same patterns always come out the same way.
 * Validation, `active`-only and one-per-key are the ranked list's rules. `null` candidates —
 * a source that cannot say, e.g. a past week — are `unavailable`, never presented as "none".
 */
export function selectPatternFacts(candidates: readonly unknown[] | null): PatternFactSelection {
  if (candidates === null) return { status: 'unavailable', items: [] };

  const seen = new Set<string>();
  const items = activePatterns(candidates)
    .filter((pattern) => isFactualKind(pattern.kind))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((pattern) => {
      if (seen.has(pattern.key)) return false;
      seen.add(pattern.key);
      return true;
    });

  return { status: items.length > 0 ? 'available' : 'none', items };
}
