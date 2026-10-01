import { describe, expect, it } from 'vitest';
import { patternDirectionEnum, patternKindEnum, patternStatusEnum } from '../../src/database/schema/enums.js';
import { PATTERN_DIRECTIONS, PATTERN_KINDS } from '../../src/insights/pattern-evidence.js';
import { addLocalDays } from '../../src/lib/local-date.js';
import { evaluateCorrelation, type CorrelationResult } from '../../src/patterns/correlation.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import {
  DISMISSAL_COOLDOWN_DAYS,
  STALE_RETENTION_DAYS,
  decideDetection,
  staleRetentionCutoff,
  type LifecycleState,
} from '../../src/patterns/lifecycle.js';
import { METRIC_KEYS, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';
import { PatternContractError, toDetectedPattern } from '../../src/patterns/persistence.js';
import { DETECTOR_REGISTRY } from '../../src/patterns/registry.js';

/**
 * The pure half of pattern persistence: the lifecycle decisions and the mapping from a
 * detector result to the facts a `patterns` row stores. The repository half is tested
 * against PostgreSQL in `tests/integration/pattern-persistence.test.ts`.
 */

const DAY_MS = 86_400_000;
const NOW = new Date('2026-05-01T02:15:00Z');
const daysBefore = (days: number, ms = 0) => new Date(NOW.getTime() - days * DAY_MS + ms);

const WINDOW = windowEnding('2026-04-30', 30);
const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;

/** A real correlation result: longer gaps between logs, fewer meals logged. */
function negativeCorrelation(): CorrelationResult {
  const features: DailyFeatures[] = Array.from({ length: 24 }, (_, i) => {
    const gap = 2 + (i % 12);
    return {
      localDate: addLocalDays(WINDOW.from, i),
      observed: true,
      values: { ...EMPTY, logging_gap_hours: gap, meals_logged: Math.max(0, 5 - Math.floor(gap / 3)) },
    };
  });
  const evaluation = evaluateCorrelation(features, { subject: 'logging_gap_hours', object: 'meals_logged' }, WINDOW);
  if (evaluation.outcome !== 'emitted') throw new Error('fixture should emit');
  return evaluation.result;
}

describe('persisted vocabulary', () => {
  it('stores the kinds and directions the consumer contract defines, and only three statuses', () => {
    expect(patternKindEnum.enumValues).toEqual([...PATTERN_KINDS]);
    expect(patternDirectionEnum.enumValues).toEqual([...PATTERN_DIRECTIONS]);
    expect(patternStatusEnum.enumValues).toEqual(['active', 'stale', 'dismissed']);
  });

  it('gives every detector family a version to store with its patterns', () => {
    for (const registration of Object.values(DETECTOR_REGISTRY)) {
      expect(registration.version).toBe(`${registration.family}@1`);
    }
  });
});

describe('lifecycle decisions (PATTERN_ENGINE.md §4)', () => {
  const state = (status: LifecycleState['status'], statusChangedAt = daysBefore(1)): LifecycleState => ({
    status,
    statusChangedAt,
    windowEnd: '2026-04-29',
  });

  it('keeps the documented durations', () => {
    expect(STALE_RETENTION_DAYS).toBe(30);
    expect(DISMISSAL_COOLDOWN_DAYS).toBe(60);
  });

  it('re-detects an active pattern and reactivates a stale one', () => {
    expect(decideDetection(state('active'), '2026-04-30', NOW)).toBe('redetect');
    expect(decideDetection(state('stale'), '2026-04-30', NOW)).toBe('reactivate');
  });

  it('suppresses a dismissed pattern until 60 full days have passed, then reactivates it', () => {
    expect(decideDetection(state('dismissed', daysBefore(1)), '2026-04-30', NOW)).toBe('suppressed');
    expect(decideDetection(state('dismissed', daysBefore(60, 1)), '2026-04-30', NOW)).toBe('suppressed');
    expect(decideDetection(state('dismissed', daysBefore(60)), '2026-04-30', NOW)).toBe('reactivate');
    expect(decideDetection(state('dismissed', daysBefore(90)), '2026-04-30', NOW)).toBe('reactivate');
  });

  it('lets a rerun of the same window through, and refuses an older window in every status', () => {
    expect(decideDetection(state('active'), '2026-04-29', NOW)).toBe('redetect');
    for (const status of ['active', 'stale', 'dismissed'] as const) {
      expect(decideDetection(state(status, daysBefore(90)), '2026-04-28', NOW)).toBe('outdated');
    }
  });

  it('puts the stale retention cut-off exactly 30 days before now', () => {
    expect(staleRetentionCutoff(NOW)).toEqual(daysBefore(30));
  });
});

describe('DetectorResult → persisted facts', () => {
  it('copies every measured field and adds only the detector version', () => {
    const result = negativeCorrelation();
    const detected = toDetectedPattern(result);

    expect(detected).toEqual({
      key: 'correlation:logging_gap_hours:meals_logged',
      kind: 'correlation',
      subjectMetric: 'logging_gap_hours',
      objectMetric: 'meals_logged',
      direction: 'negative',
      strength: result.strength,
      pValue: result.pValue,
      sampleSize: 24,
      coverage: result.coverage,
      windowStart: WINDOW.from,
      windowEnd: WINDOW.to,
      windowDays: 30,
      evidence: { points: result.evidence },
      detectorVersion: 'correlation@1',
    });
    expect(detected.strength).toBeGreaterThan(0);
    expect(detected.evidence.points).not.toBe(result.evidence);
  });

  it.each<[string, (result: CorrelationResult) => CorrelationResult]>([
    ['a signed strength', (r) => ({ ...r, strength: -r.strength })],
    ['a strength above 1', (r) => ({ ...r, strength: 1.2 })],
    ['a p-value outside 0..1', (r) => ({ ...r, pValue: 1.5 })],
    ['a coverage outside 0..1', (r) => ({ ...r, coverage: Number.NaN })],
    ['a key that is not the canonical one', (r) => ({ ...r, key: 'correlation:meals_logged:logging_gap_hours' })],
    ['a pair that is not approved', (r) => ({ ...r, subjectMetric: 'water_ml' as MetricKey })],
    ['the pair in the wrong orientation', (r) => ({ ...r, subjectMetric: 'meals_logged', objectMetric: 'logging_gap_hours' })],
    ['a window length that does not match its dates', (r) => ({ ...r, windowDays: 31 })],
    ['evidence that does not hold sampleSize points', (r) => ({ ...r, sampleSize: r.sampleSize + 1 })],
    [
      'evidence outside the window',
      (r) => ({ ...r, evidence: [...r.evidence.slice(1), { localDate: '2026-05-01', subject: 1, object: 1 }] }),
    ],
  ])('refuses %s', (_label, corrupt) => {
    expect(() => toDetectedPattern(corrupt(negativeCorrelation()))).toThrow(PatternContractError);
  });
});
