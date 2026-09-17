import { describe, expect, it } from 'vitest';
import {
  MAX_STORY_PATTERNS,
  NO_PATTERN_ENGINE,
  selectPatternEvidence,
} from '../../src/insights/pattern-evidence.js';

/**
 * Consuming Pattern Engine output (PATTERN_ENGINE.md).
 *
 * The weekly story does not compute patterns and does not re-check the engine's
 * statistical gates — it takes the engine's verdict. What it must do is refuse anything
 * malformed, show only `active` patterns, and never produce a pattern it was not given.
 */

/** Loosely typed on purpose: several tests hand the consumer something malformed. */
function pattern(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sleep-breakfast',
    kind: 'correlation',
    subjectMetric: 'bedtime_min',
    subjectLabel: 'Bedtime',
    objectMetric: 'breakfast_logged',
    objectLabel: 'Breakfast logged',
    direction: 'negative',
    strength: -0.62,
    pValue: 0.04,
    sampleSize: 14,
    windowDays: 30,
    coverage: 0.8,
    status: 'active',
    score: 0.7,
    caveat: 'This is an association in your own logs, not a cause.',
    ...overrides,
  };
}

describe('pattern evidence', () => {
  it('reports an absent engine as unavailable, distinct from finding nothing', async () => {
    expect(selectPatternEvidence(await NO_PATTERN_ENGINE.forPeriod('user', { from: 'a', to: 'b' }))).toEqual({
      status: 'unavailable',
      items: [],
    });
    expect(selectPatternEvidence([])).toEqual({ status: 'none', items: [] });
  });

  it('includes a valid active pattern with its caveat intact', () => {
    const selection = selectPatternEvidence([pattern()]);

    expect(selection.status).toBe('available');
    expect(selection.items).toHaveLength(1);
    expect(selection.items[0]?.caveat).toBe('This is an association in your own logs, not a cause.');
  });

  it('excludes a candidate the engine has not promoted — below its sample gate, for instance', () => {
    const selection = selectPatternEvidence([
      pattern({ id: 'small-sample', status: 'candidate', sampleSize: 6 }),
      pattern({ id: 'stale', status: 'stale' }),
      pattern({ id: 'dismissed', status: 'dismissed' }),
    ]);
    expect(selection).toEqual({ status: 'none', items: [] });
  });

  it('drops malformed evidence instead of repairing it', () => {
    const { caveat: _caveat, ...withoutCaveat } = pattern({ id: 'no-caveat' });
    const selection = selectPatternEvidence([
      withoutCaveat,
      pattern({ id: 'blank-caveat', caveat: '   ' }),
      pattern({ id: 'impossible-strength', strength: 3 }),
      pattern({ id: 'zero-sample', sampleSize: 0 }),
      pattern({ id: 'unknown-kind', kind: 'vibes' }),
      'not an object',
      null,
    ]);
    expect(selection).toEqual({ status: 'none', items: [] });
  });

  it('ranks by the engine score, then by evidence, then by id — and caps the list', () => {
    const selection = selectPatternEvidence([
      pattern({ id: 'd', score: 0.4 }),
      pattern({ id: 'b', score: 0.9, sampleSize: 12 }),
      pattern({ id: 'a', score: 0.9, sampleSize: 20 }),
      pattern({ id: 'c', score: 0.9, sampleSize: 12 }),
      pattern({ id: 'e', score: 0.1 }),
    ]);

    expect(selection.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(selection.items).toHaveLength(MAX_STORY_PATTERNS);
  });

  it('never returns a pattern it was not given, and never the same one twice', () => {
    const input = [pattern({ id: 'x' }), pattern({ id: 'x', score: 0.2 }), pattern({ id: 'y', score: 0.5 })];
    const selection = selectPatternEvidence(input);

    expect(selection.items.map((item) => item.id)).toEqual(['x', 'y']);
    expect(selection.items[0]?.score).toBe(0.7);
  });
});
