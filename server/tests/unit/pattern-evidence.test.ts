import { describe, expect, it } from 'vitest';
import {
  MAX_STORY_PATTERNS,
  NO_PATTERN_ENGINE,
  selectPatternEvidence,
} from '../../src/insights/pattern-evidence.js';
import { caveatFor } from '../../src/patterns/caveats.js';
import {
  RECENCY_HALF_LIFE_DAYS,
  SCORE_WEIGHTS,
  actionabilityOf,
  compareRanked,
  rankPatterns,
  recency,
  scorePattern,
} from '../../src/patterns/ranking.js';
import { DETECTOR_REGISTRY, emittingFamilies } from '../../src/patterns/registry.js';

/**
 * Consuming Pattern Engine output (PATTERN_ENGINE.md, PATTERN_ENGINE_DECISIONS.md D6, D10).
 *
 * The consumer does not compute patterns and does not re-check the engine's statistical
 * gates. It refuses anything malformed, keeps only `active` patterns, and orders them by
 * the serving rank — score, then strength, then lastDetectedAt, then key — against an
 * explicit reference date.
 */

const TODAY = '2026-09-14';

/** Loosely typed on purpose: several tests hand the consumer something malformed. */
function pattern(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-1',
    key: 'correlation:logging_gap_hours:meals_logged',
    kind: 'correlation',
    subjectMetric: 'logging_gap_hours',
    subjectLabel: 'Longest gap between logs',
    objectMetric: 'meals_logged',
    objectLabel: 'Meals logged',
    direction: 'negative',
    strength: 0.62,
    pValue: 0.04,
    sampleSize: 14,
    coverage: 0.8,
    windowStart: '2026-08-15',
    windowEnd: TODAY,
    windowDays: 31,
    evidence: { points: [{ localDate: '2026-08-15', subject: 3, object: 4 }] },
    detectorVersion: 'correlation@1',
    status: 'active',
    firstDetectedAt: '2026-09-01T19:15:00.000Z',
    lastDetectedAt: '2026-09-13T19:15:00.000Z',
    statusChangedAt: '2026-09-01T19:15:00.000Z',
    caveat: 'This is an association in your own logs, not a cause.',
    ...overrides,
  };
}

const ids = (selection: ReturnType<typeof selectPatternEvidence>) => selection.items.map((item) => item.id);

describe('availability', () => {
  it('reports an absent engine as unavailable, distinct from finding nothing', async () => {
    const absent = await NO_PATTERN_ENGINE.forPeriod('user', { from: '2026-09-07', to: '2026-09-13', today: TODAY });
    expect(absent).toBeNull();
    expect(selectPatternEvidence(absent, TODAY)).toEqual({ status: 'unavailable', items: [] });
    expect(selectPatternEvidence([], TODAY)).toEqual({ status: 'none', items: [] });
  });
});

describe('the evidence contract', () => {
  it('includes a valid active pattern with every served field intact', () => {
    const selection = selectPatternEvidence([pattern()], TODAY);

    expect(selection.status).toBe('available');
    expect(selection.items[0]).toMatchObject({
      key: 'correlation:logging_gap_hours:meals_logged',
      lastDetectedAt: '2026-09-13T19:15:00.000Z',
      windowEnd: TODAY,
      detectorVersion: 'correlation@1',
      evidence: { points: [{ localDate: '2026-08-15', subject: 3, object: 4 }] },
      caveat: 'This is an association in your own logs, not a cause.',
    });
  });

  it('keeps only active patterns — stale, dismissed and candidate are not current', () => {
    const selection = selectPatternEvidence(
      [
        pattern({ id: 'stale', key: 'k:stale', status: 'stale' }),
        pattern({ id: 'dismissed', key: 'k:dismissed', status: 'dismissed' }),
        pattern({ id: 'candidate', key: 'k:candidate', status: 'candidate' }),
      ],
      TODAY,
    );
    expect(selection).toEqual({ status: 'none', items: [] });
  });

  it('drops malformed evidence instead of repairing it — a signed strength included', () => {
    const { key: _key, ...withoutKey } = pattern({ id: 'no-key' });
    const { lastDetectedAt: _last, ...withoutLastDetected } = pattern({ id: 'no-last-detected' });
    const selection = selectPatternEvidence(
      [
        withoutKey,
        withoutLastDetected,
        pattern({ id: 'signed-strength', strength: -0.62 }),
        pattern({ id: 'impossible-strength', strength: 3 }),
        pattern({ id: 'blank-caveat', caveat: '   ' }),
        pattern({ id: 'zero-sample', sampleSize: 0 }),
        pattern({ id: 'unknown-kind', kind: 'vibes' }),
        pattern({ id: 'bad-window', windowEnd: '14/09/2026' }),
        'not an object',
        null,
      ],
      TODAY,
    );
    expect(selection).toEqual({ status: 'none', items: [] });
  });

  it('keeps a pattern whose caveat is null — a missing hedge does not hide it', () => {
    const selection = selectPatternEvidence([pattern({ caveat: null })], TODAY);
    expect(selection.status).toBe('available');
    expect(selection.items[0]?.caveat).toBeNull();
  });

  it('carries the sign in direction and a non-negative strength either way', () => {
    const selection = selectPatternEvidence(
      [
        pattern({ id: 'neg', key: 'k:neg', direction: 'negative', strength: 0.62 }),
        pattern({ id: 'pos', key: 'k:pos', direction: 'positive', strength: 0.62 }),
      ],
      TODAY,
    );
    expect(selection.items.map((item) => [item.direction, item.strength])).toEqual([
      ['negative', 0.62],
      ['positive', 0.62],
    ]);
  });

  it('returns one pattern per key, and only patterns it was given', () => {
    const selection = selectPatternEvidence(
      [pattern({ id: 'x', key: 'k:x' }), pattern({ id: 'x2', key: 'k:x', strength: 0.5 }), pattern({ id: 'y', key: 'k:y', strength: 0.5 })],
      TODAY,
    );
    expect(ids(selection)).toEqual(['x', 'y']);
  });
});

describe('ranking (D10)', () => {
  it('uses the decided weights, half-life and correlation actionability', () => {
    expect(SCORE_WEIGHTS).toEqual({ strength: 0.5, recency: 0.3, actionability: 0.2 });
    expect(RECENCY_HALF_LIFE_DAYS).toBe(14);
    expect(actionabilityOf('correlation')).toBe(0.7);
    for (const kind of ['timing', 'trend', 'frequency', 'streak'] as const) expect(actionabilityOf(kind)).toBeNull();
  });

  it('gives recency 1 when the evidence ends on the reference date, halving every 14 days', () => {
    expect(recency(TODAY, TODAY)).toBe(1);
    expect(recency('2026-08-31', TODAY)).toBe(0.5);
    expect(recency('2026-08-17', TODAY)).toBe(0.25);
    expect(recency('2026-09-13', TODAY)).toBe(2 ** (-1 / 14));
    expect(recency('2026-09-13', TODAY)).toBeLessThan(recency(TODAY, TODAY));
    // A window ending after the reference date is not "more recent than now".
    expect(recency('2026-09-20', TODAY)).toBe(1);
  });

  it('scores exactly 0.50·strength + 0.30·recency + 0.20·actionability, unrounded', () => {
    const p = { key: 'k', kind: 'correlation' as const, strength: 0.62, windowEnd: '2026-09-07', lastDetectedAt: '2026-09-07T19:00:00Z' };
    const expected = 0.5 * 0.62 + 0.3 * 2 ** (-7 / 14) + 0.2 * 0.7;
    expect(scorePattern(p, TODAY)).toBe(expected);
    expect(scorePattern({ ...p, strength: 1, windowEnd: TODAY }, TODAY)).toBe(0.5 + 0.3 + 0.2 * 0.7);
    expect(scorePattern({ ...p, kind: 'trend' }, TODAY)).toBeNull();
  });

  it('returns the computed score with each selected pattern, never a stored one', () => {
    const selection = selectPatternEvidence([pattern({ score: 0.01 })], TODAY);
    expect(selection.items[0]?.score).toBe(0.5 * 0.62 + 0.3 * 1 + 0.2 * 0.7);
  });

  it('orders by score DESC, then strength DESC, then lastDetectedAt DESC, then key ASC', () => {
    // Explicit scores, so every level of the tie-break is exercised exactly.
    const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T19:15:00.000Z`;
    const row = (id: string, score: number, strength: number, lastDetectedAt: string, key: string) => ({
      id, score, strength, lastDetectedAt, key, kind: 'correlation' as const, windowEnd: TODAY,
    });
    const ordered = [
      row('4-key-b', 0.8, 0.6, at(10), 'k:b'),
      row('5-low-score', 0.7, 0.99, at(13), 'k:a'),
      row('2-stronger', 0.8, 0.7, at(1), 'k:z'),
      row('1-top-score', 0.9, 0.1, at(1), 'k:z'),
      row('3-key-a', 0.8, 0.6, at(10), 'k:a'),
      row('2b-newer', 0.8, 0.6, at(12), 'k:y'),
    ].sort(compareRanked);

    expect(ordered.map((item) => item.id)).toEqual(['1-top-score', '2-stronger', '2b-newer', '3-key-a', '4-key-b', '5-low-score']);
  });

  it('ranks by the computed score: fresher evidence first at equal strength', () => {
    const ranked = rankPatterns(
      [
        { id: 'old', key: 'k:a', kind: 'correlation' as const, strength: 0.6, windowEnd: '2026-08-01', lastDetectedAt: '2026-09-13T19:15:00Z' },
        { id: 'fresh', key: 'k:b', kind: 'correlation' as const, strength: 0.6, windowEnd: TODAY, lastDetectedAt: '2026-09-01T19:15:00Z' },
        { id: 'trend', key: 'k:c', kind: 'trend' as const, strength: 1, windowEnd: TODAY, lastDetectedAt: '2026-09-13T19:15:00Z' },
      ],
      TODAY,
    );
    // The trend has no decided actionability, so it cannot be scored and is not ranked.
    expect(ranked.map((item) => item.id)).toEqual(['fresh', 'old']);
  });

  it('ignores sample size and id', () => {
    const selection = selectPatternEvidence(
      [
        pattern({ id: 'z-big-sample', key: 'k:b', sampleSize: 30 }),
        pattern({ id: 'a-small-sample', key: 'k:a', sampleSize: 12 }),
      ],
      TODAY,
    );
    expect(ids(selection)).toEqual(['a-small-sample', 'z-big-sample']);
  });

  it('caps the list at three', () => {
    const selection = selectPatternEvidence(
      ['a', 'b', 'c', 'd', 'e'].map((k) => pattern({ id: k, key: `k:${k}` })),
      TODAY,
    );
    expect(ids(selection)).toEqual(['a', 'b', 'c']);
    expect(selection.items).toHaveLength(MAX_STORY_PATTERNS);
  });
});

describe('caveats (D6)', () => {
  it('has engine-authored copy for every kind allowed to emit, in the evidence locale', () => {
    for (const family of emittingFamilies()) {
      for (const kind of DETECTOR_REGISTRY[family].kinds) expect(caveatFor(kind, 'en')).toMatch(/not a cause/);
    }
  });

  it('returns null where no copy is authored, rather than inventing one', () => {
    expect(caveatFor('correlation', 'vi')).toBeNull();
    expect(caveatFor('trend', 'en')).toBeNull();
  });
});
