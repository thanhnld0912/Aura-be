import { describe, expect, it } from 'vitest';
import { EnvValidationError } from '../../src/config/env.js';
import type { Db } from '../../src/database/client.js';
import {
  NO_PATTERN_ENGINE,
  readPatternAnswer,
  selectPatternEvidence,
  selectPatternFacts,
  type PatternEvidenceAnswer,
} from '../../src/insights/pattern-evidence.js';
import { addLocalDays, todayIn } from '../../src/lib/local-date.js';
import {
  PatternsEvidenceSource,
  createPatternEvidenceSource,
} from '../../src/modules/patterns/patterns-evidence-source.js';
import type { PatternRow } from '../../src/modules/patterns/patterns.repository.js';
import { MAX_EVALUATION_LAG_DAYS, evaluationState, isServable } from '../../src/patterns/freshness.js';
import { testEnv } from '../helpers/app.js';

/**
 * Serving patterns, without a database: the activation flag, what the source may answer for
 * each evaluation state, and the freshness policy. The same paths against PostgreSQL and the
 * HTTP surface are in `tests/integration/pattern-consumer.test.ts`.
 */

const TODAY = '2026-09-16';
const LAST_CLOSED = '2026-09-15';
const WEEK = { from: '2026-09-14', to: '2026-09-20', today: TODAY };

/** A database that must not be touched: any use of it fails the test. */
const untouchableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the database was read (${String(property)}) while patterns are not served`);
    },
  },
) as unknown as Db;

describe('PATTERN_ENGINE_ENABLED', () => {
  it('is off when unset', () => {
    expect(testEnv().PATTERN_ENGINE_ENABLED).toBe(false);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['true', true],
    ['1', true],
  ])('reads %s as %s', (value, expected) => {
    expect(testEnv({ PATTERN_ENGINE_ENABLED: value }).PATTERN_ENGINE_ENABLED).toBe(expected);
  });

  it.each(['yes', 'on', 'TRUE', 'True', 'enabled', ' true', '2', ''])(
    'refuses %j instead of reading it as on or off',
    (value) => {
      expect(() => testEnv({ PATTERN_ENGINE_ENABLED: value })).toThrow(EnvValidationError);
    },
  );

  it('is independent of the scheduler flag, in both directions', () => {
    const consumerOnly = testEnv({ PATTERN_ENGINE_ENABLED: 'true' });
    expect(consumerOnly).toMatchObject({ PATTERN_ENGINE_ENABLED: true, CRON_ENABLED: false });

    const schedulerOnly = testEnv({ CRON_ENABLED: 'true' });
    expect(schedulerOnly).toMatchObject({ PATTERN_ENGINE_ENABLED: false, CRON_ENABLED: true });
  });
});

describe('createPatternEvidenceSource', () => {
  it('serves nothing and reads nothing while the flag is off', async () => {
    const source = createPatternEvidenceSource({ PATTERN_ENGINE_ENABLED: false }, untouchableDb);
    expect(source).toBe(NO_PATTERN_ENGINE);
    expect(await source.forPeriod('user-a', WEEK)).toBeNull();
  });

  it('is not switched on by the scheduler flag', () => {
    const env = testEnv({ CRON_ENABLED: 'true' });
    expect(createPatternEvidenceSource(env, untouchableDb)).toBe(NO_PATTERN_ENGINE);
  });

  it('serves the persisted patterns when the flag is on — and still reads nothing until asked', () => {
    const source = createPatternEvidenceSource({ PATTERN_ENGINE_ENABLED: true }, untouchableDb);
    expect(source).toBeInstanceOf(PatternsEvidenceSource);
  });
});

describe('evaluationState — the freshness policy', () => {
  it('tolerates exactly one closed day of lag', () => {
    expect(MAX_EVALUATION_LAG_DAYS).toBe(1);
  });

  it.each([
    [null, 'never', null, false],
    [LAST_CLOSED, 'fresh', 0, true],
    ['2026-09-14', 'delayed', 1, true],
    ['2026-09-13', 'stale', 2, false],
    ['2026-08-01', 'stale', 45, false],
    // The reader's own today, and later: not a closed day, so not a completed evaluation.
    [TODAY, 'invalid', null, false],
    ['2026-09-30', 'invalid', null, false],
    ['2026-02-30', 'invalid', null, false],
    ['not-a-date', 'invalid', null, false],
  ] as const)('a watermark of %s is %s', (evaluatedThrough, freshness, lagDays, servable) => {
    const state = evaluationState(evaluatedThrough, TODAY);
    expect(state).toEqual({ freshness, lagDays });
    expect(isServable(state)).toBe(servable);
  });

  it('measures against the user’s own calendar, not one shared clock', () => {
    // One instant: still 15 September in Los Angeles, already the 16th in Ho Chi Minh City.
    const instant = new Date('2026-09-15T18:00:00Z');
    const hcmToday = todayIn('Asia/Ho_Chi_Minh', instant);
    const laToday = todayIn('America/Los_Angeles', instant);
    expect([hcmToday, laToday]).toEqual(['2026-09-16', '2026-09-15']);

    // The same watermark is two days behind for one reader and one day behind for the other.
    expect(evaluationState('2026-09-13', hcmToday).freshness).toBe('stale');
    expect(evaluationState('2026-09-13', laToday).freshness).toBe('delayed');
    // And a day that is closed in Ho Chi Minh City is still "today" in Los Angeles.
    expect(evaluationState('2026-09-15', hcmToday).freshness).toBe('fresh');
    expect(evaluationState('2026-09-15', laToday).freshness).toBe('invalid');
  });

  it('turns over at the user’s local midnight', () => {
    const before = todayIn('Asia/Ho_Chi_Minh', new Date('2026-09-16T16:59:00Z')); // 23:59 on the 16th
    const after = todayIn('Asia/Ho_Chi_Minh', new Date('2026-09-16T17:00:00Z')); // 00:00 on the 17th
    expect(evaluationState(LAST_CLOSED, before).freshness).toBe('fresh');
    // Midnight closes the 16th; last night's run has not evaluated it yet.
    expect(evaluationState(LAST_CLOSED, after).freshness).toBe('delayed');
    expect(evaluationState(LAST_CLOSED, addLocalDays(after, 1)).freshness).toBe('stale');
  });
});

/** A persisted row as the repository returns it. */
function row(overrides: Partial<PatternRow> = {}): PatternRow {
  const at = new Date('2026-09-16T00:00:00Z');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-a',
    key: 'streak:logged_days',
    kind: 'streak',
    subjectMetric: 'logged_day',
    objectMetric: null,
    direction: 'none',
    strength: 12 / 45,
    pValue: null,
    sampleSize: 12,
    coverage: 32 / 45,
    windowStart: addLocalDays(LAST_CLOSED, -44),
    windowEnd: LAST_CLOSED,
    windowDays: 45,
    evidence: {
      type: 'logged_days',
      run: { from: addLocalDays(LAST_CLOSED, -11), to: LAST_CLOSED, length: 12 },
      current: true,
      observedDays: 32,
      windowDays: 45,
    },
    detectorVersion: 'frequency_streak@1',
    status: 'active',
    firstDetectedAt: at,
    lastDetectedAt: at,
    statusChangedAt: at,
    ...overrides,
  } as PatternRow;
}

function sourceOver(state: { evaluatedThrough: string | null; active: PatternRow[] }) {
  const reads: string[] = [];
  const source = new PatternsEvidenceSource({
    async currentState(userId) {
      reads.push(userId);
      return state;
    },
  });
  return { source, reads };
}

const selections = (answer: PatternEvidenceAnswer) => {
  const { candidates } = readPatternAnswer(answer);
  return { ranked: selectPatternEvidence(candidates, TODAY).status, facts: selectPatternFacts(candidates).status };
};

describe('PatternsEvidenceSource', () => {
  it('cannot say for a user no run has reached — an empty table is not "nothing found"', async () => {
    const { source } = sourceOver({ evaluatedThrough: null, active: [] });
    const answer = await source.forPeriod('user-a', WEEK);
    expect(answer).toEqual({ unavailable: 'not_evaluated' });
    expect(selections(answer)).toEqual({ ranked: 'unavailable', facts: 'unavailable' });
  });

  it('does not treat rows without a watermark as an evaluation', async () => {
    const { source } = sourceOver({ evaluatedThrough: null, active: [row()] });
    expect(await source.forPeriod('user-a', WEEK)).toEqual({ unavailable: 'not_evaluated' });
  });

  it('answers [] only when a current evaluation holds no pattern', async () => {
    const { source } = sourceOver({ evaluatedThrough: LAST_CLOSED, active: [] });
    const answer = await source.forPeriod('user-a', WEEK);
    expect(answer).toEqual([]);
    expect(selections(answer)).toEqual({ ranked: 'none', facts: 'none' });
  });

  it('serves what a fresh evaluation confirmed', async () => {
    const { source } = sourceOver({ evaluatedThrough: LAST_CLOSED, active: [row()] });
    const answer = await source.forPeriod('user-a', WEEK);
    expect(answer).toHaveLength(1);
    expect(selections(answer)).toEqual({ ranked: 'none', facts: 'available' });
  });

  it('still serves one day behind — tonight’s run has not reached the user yet', async () => {
    const through = addLocalDays(LAST_CLOSED, -1);
    const { source } = sourceOver({
      evaluatedThrough: through,
      active: [row({ windowEnd: through, windowStart: addLocalDays(through, -44) })],
    });
    expect(await source.forPeriod('user-a', WEEK)).toHaveLength(1);
  });

  it('withholds everything once a nightly run was missed, though the rows are still active', async () => {
    const through = addLocalDays(LAST_CLOSED, -2);
    const { source } = sourceOver({
      evaluatedThrough: through,
      active: [row({ windowEnd: through, windowStart: addLocalDays(through, -44) })],
    });
    const answer = await source.forPeriod('user-a', WEEK);
    expect(answer).toEqual({ unavailable: 'evaluation_stale' });
    expect(selections(answer)).toEqual({ ranked: 'unavailable', facts: 'unavailable' });
  });

  it.each([TODAY, addLocalDays(TODAY, 5)])('refuses a watermark of %s, a day not closed yet', async (through) => {
    const { source } = sourceOver({ evaluatedThrough: through, active: [row({ windowEnd: through })] });
    expect(await source.forPeriod('user-a', WEEK)).toEqual({ unavailable: 'evaluation_invalid' });
  });

  it('leaves out an active row the latest run did not confirm', async () => {
    const old = row({
      id: '22222222-2222-4222-8222-222222222222',
      key: 'correlation:logging_gap_hours:meals_logged',
      windowEnd: addLocalDays(LAST_CLOSED, -20),
    });
    const { source } = sourceOver({ evaluatedThrough: LAST_CLOSED, active: [old, row()] });
    const answer = (await source.forPeriod('user-a', WEEK)) as Array<{ id: string }>;
    expect(answer.map((item) => item.id)).toEqual([row().id]);
  });

  it('serves nothing when a row is newer than the watermark that should cover it', async () => {
    const through = addLocalDays(LAST_CLOSED, -1);
    const { source } = sourceOver({ evaluatedThrough: through, active: [row()] });
    expect(await source.forPeriod('user-a', WEEK)).toEqual({ unavailable: 'evaluation_invalid' });
  });

  it('cannot say what a past week held, and does not read the table to find out', async () => {
    const { source, reads } = sourceOver({ evaluatedThrough: LAST_CLOSED, active: [row()] });
    expect(await source.forPeriod('user-a', { from: '2026-09-07', to: '2026-09-13', today: TODAY })).toEqual({
      unavailable: 'period_not_current',
    });
    expect(reads).toEqual([]);
  });

  it('reads only the user it was asked about', async () => {
    const { source, reads } = sourceOver({ evaluatedThrough: LAST_CLOSED, active: [] });
    await source.forPeriod('user-b', WEEK);
    expect(reads).toEqual(['user-b']);
  });
});

describe('readPatternAnswer', () => {
  it('reads an array as a result and everything else as "cannot say"', () => {
    expect(readPatternAnswer([])).toEqual({ candidates: [], unavailable: null });
    expect(readPatternAnswer(null)).toEqual({ candidates: null, unavailable: 'no_engine' });
    expect(readPatternAnswer({ unavailable: 'evaluation_stale' })).toEqual({
      candidates: null,
      unavailable: 'evaluation_stale',
    });
    expect(readPatternAnswer({ unavailable: 'made_up' } as unknown as PatternEvidenceAnswer)).toEqual({
      candidates: null,
      unavailable: 'no_engine',
    });
    expect(readPatternAnswer(undefined as unknown as PatternEvidenceAnswer).candidates).toBeNull();
  });
});

describe('PatternsEvidenceSource — follows isServable for every evaluation state', () => {
  const WATERMARKS = [null, LAST_CLOSED, '2026-09-14', '2026-09-13', '2026-08-01', TODAY, '2026-09-30', '2026-02-30', 'not-a-date'];
  const REASON = { never: 'not_evaluated', invalid: 'evaluation_invalid', stale: 'evaluation_stale' } as const;

  it.each(WATERMARKS)('a watermark of %s', async (evaluatedThrough) => {
    const state = evaluationState(evaluatedThrough, TODAY);
    const { source } = sourceOver({ evaluatedThrough, active: [] });
    const answer = await source.forPeriod('user-a', WEEK);

    // A result exactly when the policy says servable; otherwise the reason for that state.
    expect(Array.isArray(answer)).toBe(isServable(state));
    if (!isServable(state)) {
      expect(answer).toEqual({ unavailable: REASON[state.freshness as keyof typeof REASON] });
    }
  });

  it('covers every freshness the policy defines', () => {
    const seen = new Set(WATERMARKS.map((watermark) => evaluationState(watermark, TODAY).freshness));
    expect([...seen].sort()).toEqual(['delayed', 'fresh', 'invalid', 'never', 'stale']);
  });
});
