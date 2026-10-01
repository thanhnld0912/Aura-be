import type { PatternEvidenceSnapshot } from '../database/schema/patterns.js';
import { correlationKey } from './correlation.js';
import { windowDates } from './coverage.js';
import { DETECTOR_REGISTRY, approvedCorrelationPair, type DetectorResult } from './registry.js';

/**
 * DetectorResult → the facts a `patterns` row stores (PATTERN_ENGINE_DECISIONS.md D6).
 *
 * A copy, never a computation: every measured field is the detector's own value. What is
 * added is only what persistence owns — the detector version. What is checked is the
 * contract the table relies on, so a malformed result fails here, loudly, rather than as a
 * constraint violation half-way through a nightly run, or not at all:
 *
 * - the result comes from a family the registry lets emit, and (for a correlation) from an
 *   approved pair whose canonical key is the one the result carries;
 * - strength is a magnitude in 0..1 and the sign is in `direction` (D6);
 * - the evidence holds exactly the `sampleSize` points behind the statistic, inside the window.
 *
 * Lifecycle fields (status, timestamps) are not here: they belong to the repository and
 * `lifecycle.ts`. Score, caveat and labels are not persisted at all.
 */

export interface DetectedPattern {
  key: string;
  kind: DetectorResult['kind'];
  subjectMetric: string;
  objectMetric: string | null;
  direction: DetectorResult['direction'];
  strength: number;
  pValue: number | null;
  sampleSize: number;
  coverage: number;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  evidence: PatternEvidenceSnapshot;
  detectorVersion: string;
}

export class PatternContractError extends Error {
  constructor(key: string, problem: string) {
    super(`detector result ${key} cannot be persisted: ${problem}`);
    this.name = 'PatternContractError';
  }
}

const inUnitInterval = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

export function toDetectedPattern(result: DetectorResult): DetectedPattern {
  const fail = (problem: string): never => {
    throw new PatternContractError(result.key, problem);
  };

  const registration = Object.values(DETECTOR_REGISTRY).find((entry) => entry.kinds.includes(result.kind));
  if (!registration?.emits) fail(`kind ${result.kind} is not allowed to emit`);

  const pair = approvedCorrelationPair(result.subjectMetric, result.objectMetric);
  if (!pair) fail('the pair is not approved');
  if (pair!.subject !== result.subjectMetric) fail('the pair is not in its canonical orientation');
  if (correlationKey(pair!.subject, pair!.object) !== result.key) fail('the key is not the canonical key of the pair');

  if (!inUnitInterval(result.strength)) fail('strength must be a magnitude in 0..1');
  if (!inUnitInterval(result.pValue)) fail('pValue must be in 0..1');
  if (!inUnitInterval(result.coverage)) fail('coverage must be in 0..1');

  const days = windowDates({ from: result.windowStart, to: result.windowEnd });
  if (days.length !== result.windowDays) fail('windowDays does not match the window');
  if (!Number.isInteger(result.sampleSize) || result.sampleSize < 1) fail('sampleSize must be a positive integer');
  if (result.evidence.length !== result.sampleSize) fail('the evidence does not hold sampleSize points');
  const inWindow = new Set(days);
  if (!result.evidence.every((point) => inWindow.has(point.localDate))) fail('evidence lies outside the window');

  return {
    key: result.key,
    kind: result.kind,
    subjectMetric: result.subjectMetric,
    objectMetric: result.objectMetric,
    direction: result.direction,
    strength: result.strength,
    pValue: result.pValue,
    sampleSize: result.sampleSize,
    coverage: result.coverage,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    windowDays: result.windowDays,
    evidence: { points: result.evidence.map((point) => ({ ...point })) },
    detectorVersion: registration!.version,
  };
}

