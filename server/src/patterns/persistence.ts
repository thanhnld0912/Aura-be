import type { PatternEvidenceSnapshot } from '../database/schema/patterns.js';
import { streakEvidenceSchema } from '../insights/pattern-evidence.js';
import { COLD_START_WINDOW_DAYS } from './cold-start.js';
import { correlationKey, type CorrelationResult } from './correlation.js';
import { windowDates } from './coverage.js';
import { DETECTOR_REGISTRY, approvedCorrelationPair, type DetectorResult } from './registry.js';
import { LOGGING_STREAK_KEY, STREAK_SUBJECT_METRIC, streakStrength, type StreakResult } from './streak.js';

/**
 * DetectorResult → the facts a `patterns` row stores (PATTERN_ENGINE_DECISIONS.md D6).
 *
 * A copy, never a computation: every measured field is the detector's own value. What is
 * added is only what persistence owns — the detector version. What is checked is the
 * contract the table relies on, so a malformed result fails here, loudly, rather than as a
 * constraint violation half-way through a nightly run, or not at all:
 *
 * - the result's kind is one the registry lets emit;
 * - strength is a magnitude in 0..1 and the sign is in `direction` (D6);
 * - a correlation comes from an approved pair whose canonical key is the one it carries, and
 *   its evidence holds exactly the `sampleSize` points behind the statistic, inside the window;
 * - a logging streak carries the canonical key, no p-value and no sign, the D16 window, a
 *   strength that is its run's share of that window (D10 S1), and evidence that passes
 *   `streakEvidenceSchema` with the run inside the window (D6).
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
  if (!registration?.emits || !registration.emittingKinds.includes(result.kind)) {
    fail(`kind ${result.kind} is not allowed to emit`);
  }

  if (!inUnitInterval(result.strength)) fail('strength must be a magnitude in 0..1');
  if (!inUnitInterval(result.coverage)) fail('coverage must be in 0..1');
  const days = windowDates({ from: result.windowStart, to: result.windowEnd });
  if (days.length !== result.windowDays) fail('windowDays does not match the window');
  if (!Number.isInteger(result.sampleSize) || result.sampleSize < 1) fail('sampleSize must be a positive integer');

  const evidence =
    result.kind === 'streak' ? checkStreak(result, fail) : checkCorrelation(result, new Set(days), fail);

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
    evidence,
    detectorVersion: registration!.version,
  };
}

type Fail = (problem: string) => never;

function checkCorrelation(result: CorrelationResult, inWindow: ReadonlySet<string>, fail: Fail): PatternEvidenceSnapshot {
  const pair = approvedCorrelationPair(result.subjectMetric, result.objectMetric);
  if (!pair) fail('the pair is not approved');
  if (pair!.subject !== result.subjectMetric) fail('the pair is not in its canonical orientation');
  if (correlationKey(pair!.subject, pair!.object) !== result.key) fail('the key is not the canonical key of the pair');
  if (!inUnitInterval(result.pValue)) fail('pValue must be in 0..1');
  if (result.evidence.length !== result.sampleSize) fail('the evidence does not hold sampleSize points');
  if (!result.evidence.every((point) => inWindow.has(point.localDate))) fail('evidence lies outside the window');
  return { points: result.evidence.map((point) => ({ ...point })) };
}

function checkStreak(result: StreakResult, fail: Fail): PatternEvidenceSnapshot {
  if (result.key !== LOGGING_STREAK_KEY) fail('the key is not the canonical logging-streak key');
  if (result.subjectMetric !== STREAK_SUBJECT_METRIC || result.objectMetric !== null) fail('a logging streak is about logged days alone');
  if (result.direction !== 'none') fail('a streak has no sign');
  if (result.pValue !== null) fail('a streak runs no test, so it has no p-value');
  if (result.windowDays !== COLD_START_WINDOW_DAYS) fail(`a logging streak reads the ${COLD_START_WINDOW_DAYS}-day window`);

  const parsed = streakEvidenceSchema.safeParse(result.evidence);
  if (!parsed.success) fail(`invalid evidence: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  const { run, current, observedDays } = parsed.data!;
  if (run.from < result.windowStart || run.to > result.windowEnd) fail('the run lies outside the window');
  if (current !== (run.to === result.windowEnd)) fail('current does not match where the run ends');
  if (result.sampleSize !== run.length) fail('sampleSize is not the run length');
  if (result.strength !== streakStrength(run.length)) fail('strength is not the run length over the window (D10 S1)');
  if (result.coverage !== observedDays / COLD_START_WINDOW_DAYS) fail('coverage is not the observed days over the window');
  return {
    type: 'logged_days',
    run: { ...run },
    current,
    observedDays,
    windowDays: COLD_START_WINDOW_DAYS,
  };
}
