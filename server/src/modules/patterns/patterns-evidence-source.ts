import type { Env } from '../../config/env.js';
import type { Db } from '../../database/client.js';
import {
  NO_PATTERN_ENGINE,
  type PatternEvidence,
  type PatternEvidenceAnswer,
  type PatternEvidenceSource,
  type PatternPeriodRequest,
  type PatternUnavailableReason,
} from '../../insights/pattern-evidence.js';
import { EVIDENCE_CAVEAT_LOCALE, caveatFor } from '../../patterns/caveats.js';
import { evaluationState, isServable, type EvaluationFreshness } from '../../patterns/freshness.js';
import { METRICS, type MetricKey } from '../../patterns/metrics.js';
import { PatternsRepository, type PatternRow } from './patterns.repository.js';

/**
 * Serves the persisted `patterns` through the consumer contract (`PatternEvidenceSource`).
 *
 * A projection, never a computation: every statistic is the stored detector output. What
 * is added is what the design derives at read time — the metric labels from the catalog and
 * the engine's caveat for the kind — and timestamps as ISO strings. No score: ranking is the
 * consumer's step, against its own reference date (`selectPatternEvidence`).
 *
 * ## Current state only
 *
 * The table holds the patterns the data supports **now**; it is not a history. So a period
 * that does not contain the reader's today — a past week — gets `null`, "cannot say", and
 * never `[]`, which would claim the engine looked at that week and found nothing. Nothing
 * is reconstructed from the window or the timestamps.
 *
 * ## Only what a current evaluation stands behind
 *
 * A row is `active` until a later run says otherwise, so `active` alone does not make it
 * current. The user's watermark (`pattern_watermarks.evaluated_through`, written in the same
 * transaction as the run's lifecycle changes — D17) is the proof that an authoritative run
 * completed, and `patterns/freshness.ts` decides whether it is recent enough:
 *
 * - no watermark → `not_evaluated`. An empty table is not "nothing found" for a user no run
 *   has ever reached — and rows without a watermark are not evidence either.
 * - a watermark on the reader's today or later → `evaluation_invalid`.
 * - a watermark more than one closed day behind → `evaluation_stale`.
 * - otherwise the rows are served — and only those whose evidence ends **on the watermark's
 *   day**, i.e. the ones that run confirmed. An authoritative run leaves no other active row
 *   (it refreshes what it finds and retires what it does not), so an older one is not
 *   evidence of that run and is left out; a newer one contradicts the watermark, and then
 *   nothing is served (`evaluation_invalid`).
 *
 * `[]` is therefore returned only when a current evaluation exists and holds no pattern.
 * Reading changes nothing: no lifecycle state, no watermark.
 */
/**
 * Why each freshness that is not servable cannot say. Whether a freshness *is* servable is
 * `isServable`'s decision alone (`patterns/freshness.ts`); this only names the reason, and a
 * freshness with no entry here that `isServable` refuses is reported as `evaluation_invalid`.
 */
const UNSERVABLE_REASON: Partial<Record<EvaluationFreshness, PatternUnavailableReason>> = {
  never: 'not_evaluated',
  invalid: 'evaluation_invalid',
  stale: 'evaluation_stale',
};

export class PatternsEvidenceSource implements PatternEvidenceSource {
  constructor(private readonly repository: Pick<PatternsRepository, 'currentState'>) {}

  async forPeriod(userId: string, request: PatternPeriodRequest): Promise<PatternEvidenceAnswer> {
    if (request.today < request.from || request.today > request.to) return { unavailable: 'period_not_current' };

    const { evaluatedThrough, active } = await this.repository.currentState(userId);
    const state = evaluationState(evaluatedThrough, request.today);
    if (!isServable(state) || evaluatedThrough === null) {
      return { unavailable: UNSERVABLE_REASON[state.freshness] ?? 'evaluation_invalid' };
    }

    if (active.some((row) => row.windowEnd > evaluatedThrough)) return { unavailable: 'evaluation_invalid' };
    return active.filter((row) => row.windowEnd === evaluatedThrough).map(toPatternEvidence);
  }
}

/**
 * The source an API process serves patterns from. `PATTERN_ENGINE_ENABLED` off — the default,
 * and what an unset variable means — gives `NO_PATTERN_ENGINE`, which reads nothing; on, the
 * persisted patterns behind the freshness policy above. It starts no job and writes nothing:
 * the scheduler is a separate process with its own flag (`CRON_ENABLED`), and neither implies
 * the other.
 */
export function createPatternEvidenceSource(env: Pick<Env, 'PATTERN_ENGINE_ENABLED'>, db: Db): PatternEvidenceSource {
  return env.PATTERN_ENGINE_ENABLED ? new PatternsEvidenceSource(new PatternsRepository(db)) : NO_PATTERN_ENGINE;
}

/** A metric's label from the catalog; null for a metric it does not know, which the contract then refuses. */
function labelOf(metric: string): string | null {
  return Object.hasOwn(METRICS, metric) ? METRICS[metric as MetricKey].label : null;
}

export function toPatternEvidence(row: PatternRow): PatternEvidence {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    subjectMetric: row.subjectMetric,
    // A label the catalog lacks is left empty, and the consumer drops the pattern as malformed.
    subjectLabel: labelOf(row.subjectMetric) ?? '',
    objectMetric: row.objectMetric,
    objectLabel: row.objectMetric === null ? null : (labelOf(row.objectMetric) ?? ''),
    direction: row.direction,
    strength: row.strength,
    pValue: row.pValue,
    sampleSize: row.sampleSize,
    coverage: row.coverage,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    windowDays: row.windowDays,
    evidence: row.evidence,
    detectorVersion: row.detectorVersion,
    status: row.status,
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastDetectedAt: row.lastDetectedAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
    caveat: caveatFor(row.kind, EVIDENCE_CAVEAT_LOCALE),
  };
}
