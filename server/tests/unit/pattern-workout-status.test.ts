import { describe, expect, it } from 'vitest';
import { READY_CORRELATION_PAIRS } from '../../src/patterns/correlation.js';
import { METRICS } from '../../src/patterns/metrics.js';
import { DETECTOR_REGISTRY, approvedCorrelationPair, emittingFamilies } from '../../src/patterns/registry.js';
import { isTrendable } from '../../src/patterns/trend.js';
import { testEnv } from '../helpers/app.js';

/**
 * `POST /api/workouts` gave `workout_sessions` a write path, so `workout_completed` is no
 * longer `no_write_path`. That is a fact about the data, and it must stay only that: none of
 * what the engine runs or emits may change because of it.
 */
describe('workout_completed after the workout write path', () => {
  it('is available, and says what it still cannot hold', () => {
    expect(METRICS.workout_completed.status).toBe('available');
    expect(METRICS.workout_completed.unresolved).toMatch(/1 or null .* never 0/);
  });

  it('changes no detection: still not trendable, still in no correlation pair', () => {
    expect(isTrendable('workout_completed')).toBe(false);
    expect(
      READY_CORRELATION_PAIRS.filter((pair) => pair.subject === 'workout_completed' || pair.object === 'workout_completed'),
    ).toEqual([]);
    expect(approvedCorrelationPair('workout_planned_time', 'workout_completed')).toBeNull();
    expect(approvedCorrelationPair('sleep_minutes', 'workout_completed')).toBeNull();
  });

  it('leaves timing — the family that reads it — off, and the emitting families as they were', () => {
    expect(DETECTOR_REGISTRY.timing.emits).toBe(false);
    expect(DETECTOR_REGISTRY.timing.blockedBy.some((reason) => reason.includes('POST /api/workouts'))).toBe(true);
    // The families that emitted before the write path existed, and only those.
    expect(emittingFamilies()).toEqual(['correlation', 'frequency_streak']);
  });

  it('leaves the engine disabled by default', () => {
    // `testEnv` sets nothing about the engine, so this is the schema's own default.
    expect(testEnv().PATTERN_ENGINE_ENABLED).toBe(false);
  });
});
