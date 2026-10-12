import { describe, expect, it } from 'vitest';
import {
  STREAK_WINDOW_DAYS,
  patternEvidenceSchema,
  selectPatternEvidence,
  selectPatternFacts,
  streakEvidenceSchema,
} from '../../src/insights/pattern-evidence.js';
import { buildWeeklyEvidence } from '../../src/insights/weekly-story.js';
import { EMPTY_WEEK, buildWeeklyReport } from '../../src/insights/weekly-report.js';
import { addLocalDays } from '../../src/lib/local-date.js';
import { COLD_START_WINDOW_DAYS } from '../../src/patterns/cold-start.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import { METRIC_KEYS, METRICS, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';
import { PatternContractError, toDetectedPattern } from '../../src/patterns/persistence.js';
import { rankPatterns } from '../../src/patterns/ranking.js';
import { isFactualKind } from '../../src/patterns/registry.js';
import {
  LOGGING_STREAK_KEY,
  STREAK_SUBJECT_METRIC,
  detectStreak,
  streakStrength,
  type StreakResult,
} from '../../src/patterns/streak.js';

/**
 * The logging streak as a stored, served pattern (PATTERN_ENGINE_DECISIONS.md D6, D10):
 * longest run, most recent on a tie; strength `run / 45` (S1); served as a fact beside the
 * ranked list, never in it (S3). Pure: fixed calendars, no database, no clock.
 */

const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;
const logged = (localDate: string): DailyFeatures => ({
  localDate,
  observed: true,
  values: { ...EMPTY, meals_logged: 1, logged_day: 1 },
});

const END = '2027-02-14';
const WINDOW = windowEnding(END, COLD_START_WINDOW_DAYS);

/** `L` logged, `.` nothing — 45 marks, oldest first. */
function calendar(pattern: string, end = END): DailyFeatures[] {
  if (pattern.length !== COLD_START_WINDOW_DAYS) throw new Error(`fixture must be 45 days, got ${pattern.length}`);
  const start = addLocalDays(end, -(COLD_START_WINDOW_DAYS - 1));
  return [...pattern].flatMap((mark, i) => (mark === 'L' ? [logged(addLocalDays(start, i))] : []));
}

const only = (results: StreakResult[]): StreakResult => {
  expect(results).toHaveLength(1);
  return results[0]!;
};

// 35 logged days: a 10-day run, two 12-day runs (29 Jan … 9 Feb is the later), one lone day.
const TWO_TIED = 'LLLLLLLLLL..LLLLLLLLLLLL....LLLLLLLLLLLL...L.';

describe('streak evidence (D6)', () => {
  const valid = {
    type: 'logged_days',
    run: { from: '2027-01-10', to: '2027-01-14', length: 5 },
    current: false,
    observedDays: 31,
    windowDays: 45,
  } as const;

  it('accepts a well-formed run', () => {
    expect(streakEvidenceSchema.safeParse(valid).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an impossible date', { ...valid, run: { from: '2027-02-30', to: '2027-03-02', length: 1 } }],
    ['a non-canonical date', { ...valid, run: { ...valid.run, from: '2027-1-10' } }],
    ['a run that ends before it starts', { ...valid, run: { from: '2027-01-14', to: '2027-01-10', length: 5 } }],
    ['a length that is not the days from..to', { ...valid, run: { ...valid.run, length: 4 } }],
    ['a run longer than the observed days', { ...valid, observedDays: 4 }],
    ['more observed days than the window', { ...valid, observedDays: 46 }],
    ['negative observed days', { ...valid, observedDays: -1 }],
    ['another window length', { ...valid, windowDays: 30 }],
    ['another streak type', { ...valid, type: 'meals' }],
    ['an unsupported extra field', { ...valid, confidence: 0.9 }],
  ])('rejects %s', (_name, evidence) => {
    expect(streakEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it('counts a run across a year end and a leap day by the calendar', () => {
    const across = { ...valid, run: { from: '2027-12-30', to: '2028-01-02', length: 4 } };
    const leap = { ...valid, run: { from: '2028-02-28', to: '2028-03-01', length: 3 } };
    expect(streakEvidenceSchema.safeParse(across).success).toBe(true);
    expect(streakEvidenceSchema.safeParse(leap).success).toBe(true);
    expect(streakEvidenceSchema.safeParse({ ...leap, run: { ...leap.run, length: 2 } }).success).toBe(false);
  });
});

describe('detectStreak (D10)', () => {
  it('uses the canonical key, subject and window — one pattern, never one per run', () => {
    const result = only(detectStreak(calendar(TWO_TIED), WINDOW));
    expect(result.key).toBe(LOGGING_STREAK_KEY);
    expect(result.key).toBe('streak:logged_days');
    expect(result.subjectMetric).toBe(STREAK_SUBJECT_METRIC);
    expect(METRICS.logged_day.label).toBe('Logging consistency');
    expect(result).toMatchObject({ kind: 'streak', objectMetric: null, direction: 'none', pValue: null });
    expect(result).toMatchObject({ windowStart: WINDOW.from, windowEnd: WINDOW.to, windowDays: 45 });
  });

  it('selects the longest run, and the most recent of equal runs', () => {
    const result = only(detectStreak(calendar(TWO_TIED), WINDOW));
    expect(result.evidence.run).toEqual({ from: '2027-01-29', to: '2027-02-09', length: 12 });
    expect(result.sampleSize).toBe(12);
  });

  it('marks the run current only when it ends on the last closed day', () => {
    expect(only(detectStreak(calendar(TWO_TIED), WINDOW)).evidence.current).toBe(false);
    const current = only(detectStreak(calendar(`${'L'.repeat(30)}${'.'.repeat(5)}${'L'.repeat(10)}`), WINDOW));
    expect(current.evidence.run).toEqual({ from: '2027-01-01', to: '2027-01-30', length: 30 });
    // 30 > 10: the earlier, longer run is the pattern; it does not end on END.
    expect(current.evidence.current).toBe(false);
    const ending = only(detectStreak(calendar(`${'L'.repeat(10)}${'.'.repeat(4)}${'L'.repeat(31)}`), WINDOW));
    expect(ending.evidence).toMatchObject({ run: { to: END, length: 31 }, current: true });
  });

  it('computes strength as the run over the window (S1), within [0, 1]', () => {
    expect(streakStrength(3)).toBe(3 / 45);
    expect(streakStrength(45)).toBe(1);
    const full = only(detectStreak(calendar('L'.repeat(45)), WINDOW));
    expect(full.strength).toBe(1);
    expect(full.coverage).toBe(1);
    const tied = only(detectStreak(calendar(TWO_TIED), WINDOW));
    expect(tied.strength).toBe(12 / 45);
    expect(tied.coverage).toBe(35 / 45);
    expect(tied.strength).toBeGreaterThanOrEqual(0);
    expect(tied.strength).toBeLessThanOrEqual(1);
  });

  it('detects nothing below the D16 cold-start gate, however long the run', () => {
    // 29 consecutive logged days: a long run, but fewer than 30 observed days.
    expect(detectStreak(calendar(`${'.'.repeat(16)}${'L'.repeat(29)}`), WINDOW)).toEqual([]);
    expect(detectStreak([], WINDOW)).toEqual([]);
  });

  it('detects nothing when no run reaches three days', () => {
    // 30 observed days, never three in a row.
    expect(detectStreak(calendar(`${'LL.'.repeat(15)}`), WINDOW)).toEqual([]);
    const three = only(detectStreak(calendar(`${'LL.'.repeat(14)}LLL`), WINDOW));
    expect(three.evidence.run.length).toBe(3);
  });

  it('breaks a run on a day with no row, and restarts after it', () => {
    const result = only(detectStreak(calendar(`${'L'.repeat(20)}.${'L'.repeat(24)}`), WINDOW));
    expect(result.evidence.run).toEqual({ from: addLocalDays(END, -23), to: END, length: 24 });
  });

  it('follows the user’s own calendar across a month and year boundary', () => {
    const end = '2027-01-05';
    const result = only(detectStreak(calendar('L'.repeat(45), end), windowEnding(end, 45)));
    expect(result.evidence.run).toEqual({ from: '2026-11-22', to: '2027-01-05', length: 45 });
  });

  it('reads only the 45-day D16 window', () => {
    expect(() => detectStreak(calendar('L'.repeat(45)), windowEnding(END, 30))).toThrow(/45-day window/);
  });

  it('gives the same result for the same days, whatever the input order', () => {
    const days = calendar(TWO_TIED);
    expect(detectStreak([...days].reverse(), WINDOW)).toEqual(detectStreak(days, WINDOW));
  });
});

describe('persistence mapping (D6)', () => {
  const result = () => only(detectStreak(calendar(TWO_TIED), WINDOW));

  it('maps a streak onto the patterns row with no p-value and no object', () => {
    const detected = toDetectedPattern(result());
    expect(detected).toEqual({
      key: 'streak:logged_days',
      kind: 'streak',
      subjectMetric: 'logged_day',
      objectMetric: null,
      direction: 'none',
      strength: 12 / 45,
      pValue: null,
      sampleSize: 12,
      coverage: 35 / 45,
      windowStart: WINDOW.from,
      windowEnd: WINDOW.to,
      windowDays: 45,
      evidence: {
        type: 'logged_days',
        run: { from: '2027-01-29', to: '2027-02-09', length: 12 },
        current: false,
        observedDays: 35,
        windowDays: 45,
      },
      detectorVersion: 'frequency_streak@1',
    });
  });

  it.each<[string, (r: StreakResult) => StreakResult]>([
    ['another key', (r) => ({ ...r, key: 'streak:meals' as typeof LOGGING_STREAK_KEY })],
    ['a p-value', (r) => ({ ...r, pValue: 0.01 as unknown as null })],
    ['a sign', (r) => ({ ...r, direction: 'positive' as 'none' })],
    ['a strength that is not run / 45', (r) => ({ ...r, strength: 0.5 })],
    ['a strength above 1', (r) => ({ ...r, strength: 1.2 })],
    ['a sample size that is not the run', (r) => ({ ...r, sampleSize: 11 })],
    ['a coverage that is not observed / 45', (r) => ({ ...r, coverage: 0.5 })],
    ['a run outside the window', (r) => ({ ...r, evidence: { ...r.evidence, run: { from: '2026-12-01', to: '2026-12-12', length: 12 } } })],
    ['a wrong current flag', (r) => ({ ...r, evidence: { ...r.evidence, current: true } })],
    ['malformed evidence', (r) => ({ ...r, evidence: { ...r.evidence, run: { ...r.evidence.run, length: 13 } } })],
    ['a 30-day window', (r) => ({ ...r, windowStart: addLocalDays(END, -29), windowDays: 30 })],
  ])('refuses %s', (_name, corrupt) => {
    expect(() => toDetectedPattern(corrupt(result()))).toThrow(PatternContractError);
  });
});

// ── Serving (D10 S3) ───────────────────────────────────────────────────────────

const NOW = '2027-02-15T02:15:00.000Z';
const streakPattern = (overrides: Record<string, unknown> = {}) => ({
  id: 'streak-1',
  key: 'streak:logged_days',
  kind: 'streak',
  subjectMetric: 'logged_day',
  subjectLabel: 'Logging consistency',
  objectMetric: null,
  objectLabel: null,
  direction: 'none',
  strength: 12 / 45,
  pValue: null,
  sampleSize: 12,
  coverage: 35 / 45,
  windowStart: WINDOW.from,
  windowEnd: WINDOW.to,
  windowDays: 45,
  evidence: { type: 'logged_days', run: { from: '2027-01-29', to: '2027-02-09', length: 12 }, current: false, observedDays: 35, windowDays: 45 },
  detectorVersion: 'frequency_streak@1',
  status: 'active',
  firstDetectedAt: NOW,
  lastDetectedAt: NOW,
  statusChangedAt: NOW,
  caveat: 'This counts days you logged something, not what you did.',
  ...overrides,
});
const correlationPattern = (overrides: Record<string, unknown> = {}) => ({
  id: 'corr-1',
  key: 'correlation:logging_gap_hours:meals_logged',
  kind: 'correlation',
  subjectMetric: 'logging_gap_hours',
  subjectLabel: 'Longest logging gap',
  objectMetric: 'meals_logged',
  objectLabel: 'Meals logged',
  direction: 'negative',
  strength: 0.62,
  pValue: 0.01,
  sampleSize: 2,
  coverage: 0.8,
  windowStart: addLocalDays(END, -29),
  windowEnd: END,
  windowDays: 30,
  evidence: { points: [{ localDate: END, subject: 1, object: 2 }, { localDate: addLocalDays(END, -1), subject: 3, object: 1 }] },
  detectorVersion: 'correlation@1',
  status: 'active',
  firstDetectedAt: NOW,
  lastDetectedAt: NOW,
  statusChangedAt: NOW,
  caveat: 'This is an association in your own logs, not a cause.',
  ...overrides,
});

describe('the evidence contract at the serving boundary', () => {
  it('accepts a streak and a correlation, each with its own evidence shape', () => {
    expect(patternEvidenceSchema.safeParse(streakPattern()).success).toBe(true);
    expect(patternEvidenceSchema.safeParse(correlationPattern()).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a streak with a points series', { evidence: correlationPattern().evidence }],
    ['a streak run outside its window', { evidence: { ...streakPattern().evidence, run: { from: '2026-12-01', to: '2026-12-12', length: 12 } } }],
    ['a streak whose sample size is not its run', { sampleSize: 11 }],
    ['a streak with a p-value', { pValue: 0.04 }],
    ['a streak with a wrong current flag', { evidence: { ...streakPattern().evidence, current: true } }],
    ['a streak over another window length', { windowDays: 30 }],
  ])('drops %s', (_name, overrides) => {
    expect(patternEvidenceSchema.safeParse(streakPattern(overrides)).success).toBe(false);
  });

  it('drops a correlation that carries a streak run', () => {
    expect(patternEvidenceSchema.safeParse(correlationPattern({ evidence: streakPattern().evidence })).success).toBe(false);
  });
});

describe('serving: the streak is a fact, never ranked (S3)', () => {
  it('is a factual kind with no ranking score', () => {
    expect(isFactualKind('streak')).toBe(true);
    expect(isFactualKind('correlation')).toBe(false);
    expect(rankPatterns([{ ...streakPattern(), kind: 'streak' as const, lastDetectedAt: NOW }], END)).toEqual([]);
  });

  it('keeps the streak out of the ranked list and the correlation out of the facts', () => {
    const candidates = [streakPattern(), correlationPattern()];
    const ranked = selectPatternEvidence(candidates, END);
    expect(ranked.items.map((item) => item.kind)).toEqual(['correlation']);

    const facts = selectPatternFacts(candidates);
    expect(facts).toMatchObject({ status: 'available' });
    expect(facts.items.map((item) => item.key)).toEqual(['streak:logged_days']);
  });

  it('leaves the ranked list exactly as before when a streak is present', () => {
    const withoutStreak = selectPatternEvidence([correlationPattern()], END);
    const withStreak = selectPatternEvidence([correlationPattern(), streakPattern()], END);
    expect(withStreak).toEqual(withoutStreak);
  });

  it('serves only active, valid facts, one per key', () => {
    expect(selectPatternFacts([streakPattern({ status: 'stale' })])).toEqual({ status: 'none', items: [] });
    expect(selectPatternFacts([streakPattern({ strength: 2 })])).toEqual({ status: 'none', items: [] });
    expect(selectPatternFacts([streakPattern(), streakPattern({ id: 'streak-2' })]).items).toHaveLength(1);
  });

  it('says unavailable, not none, when the source cannot say (a past week)', () => {
    expect(selectPatternFacts(null)).toEqual({ status: 'unavailable', items: [] });
  });
});

describe('weekly report: the streak is published as a fact, with its caveat', () => {
  const report = (facts: ReturnType<typeof selectPatternFacts>) =>
    buildWeeklyReport({
      weekStart: '2027-02-08',
      today: '2027-02-15',
      timezone: 'Asia/Ho_Chi_Minh',
      current: EMPTY_WEEK,
      previous: EMPTY_WEEK,
      patterns: selectPatternEvidence([correlationPattern(), streakPattern()], '2027-02-15'),
      patternFacts: facts,
    });

  it('publishes the run, its strength and the engine-owned caveat, beside the ranked patterns', () => {
    const built = report(selectPatternFacts([correlationPattern(), streakPattern()]));
    expect(built.patterns.items.map((item) => item.kind)).toEqual(['correlation']);
    expect(built.patternFacts).toEqual({
      status: 'available',
      items: [
        {
          id: 'streak-1',
          kind: 'streak',
          key: 'streak:logged_days',
          subjectMetric: 'logged_day',
          subjectLabel: 'Logging consistency',
          strength: 12 / 45,
          sampleSize: 12,
          coverage: 35 / 45,
          windowStart: WINDOW.from,
          windowEnd: WINDOW.to,
          windowDays: 45,
          run: { from: '2027-01-29', to: '2027-02-09', length: 12 },
          current: false,
          observedDays: 35,
          caveat: 'This counts days you logged something, not what you did.',
        },
      ],
    });
  });

  it('keeps a fact whose caveat is missing, rather than dropping it silently', () => {
    const built = report(selectPatternFacts([streakPattern({ caveat: null })]));
    expect(built.patternFacts.items).toHaveLength(1);
    expect(built.patternFacts.items[0]!.caveat).toBeNull();
  });

  it('reports unavailable facts for a week the engine holds no record of', () => {
    expect(report(selectPatternFacts(null)).patternFacts).toEqual({ status: 'unavailable', items: [] });
  });

  it('never hands the streak to the narrator', () => {
    const built = report(selectPatternFacts([streakPattern()]));
    const evidence = buildWeeklyEvidence(built, { locale: 'en', goalFocus: 'consistency' });
    expect(JSON.stringify(evidence)).not.toMatch(/streak|Logging consistency/);
  });

  it('keeps the window constant the evidence contract uses in step with D16', () => {
    expect(STREAK_WINDOW_DAYS).toBe(COLD_START_WINDOW_DAYS);
  });
});
