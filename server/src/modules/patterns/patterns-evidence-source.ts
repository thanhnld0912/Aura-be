import type { PatternEvidence, PatternEvidenceSource, PatternPeriodRequest } from '../../insights/pattern-evidence.js';
import { EVIDENCE_CAVEAT_LOCALE, caveatFor } from '../../patterns/caveats.js';
import { METRICS, type MetricKey } from '../../patterns/metrics.js';
import type { PatternRow, PatternsRepository } from './patterns.repository.js';

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
 */
export class PatternsEvidenceSource implements PatternEvidenceSource {
  constructor(private readonly repository: Pick<PatternsRepository, 'listActive'>) {}

  async forPeriod(userId: string, request: PatternPeriodRequest): Promise<PatternEvidence[] | null> {
    if (request.today < request.from || request.today > request.to) return null;
    const rows = await this.repository.listActive(userId);
    return rows.map(toPatternEvidence);
  }
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
