import { describe, expect, it } from 'vitest';
import { addLocalDays } from '../../src/lib/local-date.js';
import {
  COLD_START_WINDOW_DAYS,
  MIN_OBSERVED_DAYS,
  coldStart,
  observedDatesIn,
} from '../../src/patterns/cold-start.js';
import { windowEnding } from '../../src/patterns/coverage.js';
import { METRIC_KEYS, type DailyFeatures, type MetricKey } from '../../src/patterns/metrics.js';
import { DETECTOR_REGISTRY, runApprovedDetectors } from '../../src/patterns/registry.js';
import { LOGGING_STREAK_KEY, MIN_STREAK_DAYS, assessStreak, type StreakEvaluation } from '../../src/patterns/streak.js';
import { noiseDays } from '../helpers/pattern-noise.js';

/**
 * The D16 cold-start gate and the logging-streak assessment (PATTERN_ENGINE.md §3.4, §7;
 * PATTERN_ENGINE_DECISIONS.md D7, D14, D16). Both pure, both over fixed fixtures — no
 * randomness except the canonical seeded noise fixture, whose seed is pinned.
 *
 * The streak is an assessment only: the family stays blocked from emitting (D10, D6), and
 * the last block below proves no streak can leave the detector layer.
 */

const EMPTY = Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<MetricKey, number | null>;

const logged = (localDate: string, values: Partial<Record<MetricKey, number | null>> = {}): DailyFeatures => ({
  localDate,
  observed: true,
  values: { ...EMPTY, meals_logged: 1, ...values },
});

/** A summary row whose events were all deleted: it exists, but nothing was logged (§2.1). */
const unobserved = (localDate: string): DailyFeatures => ({ localDate, observed: false, values: { ...EMPTY } });

/** The last closed day every fixture's window ends on. 1 Jan … 14 Feb 2027 is exactly 45 days. */
const END = '2027-02-14';
const START = addLocalDays(END, -(COLD_START_WINDOW_DAYS - 1));

/**
 * Days of the 45-day window from a pattern string, oldest first: `L` logged, `u` an
 * unobserved row, `.` no row at all. Reading the fixture is reading the calendar.
 */
function calendar(pattern: string, start = START): DailyFeatures[] {
  if (pattern.length !== COLD_START_WINDOW_DAYS) throw new Error(`fixture must be 45 days, got ${pattern.length}`);
  return [...pattern].flatMap((mark, i) => {
    const date = addLocalDays(start, i);
    if (mark === 'L') return [logged(date)];
    if (mark === 'u') return [unobserved(date)];
    if (mark === '.') return [];
    throw new Error(`unknown mark ${mark}`);
  });
}

const passed = (evaluation: StreakEvaluation) => {
  if (evaluation.outcome !== 'passes_decided_gates') throw new Error(`expected a pass, got ${evaluation.reason}`);
  return evaluation.assessment;
};

// ── Cold start (D16 §1) ────────────────────────────────────────────────────────

describe('cold-start gate', () => {
  it('counts over the 45 calendar days ending on the last closed day', () => {
    const gate = coldStart([], END);
    expect(gate.window).toEqual({ from: START, to: END });
    expect(gate.days).toBe(45);
    expect(COLD_START_WINDOW_DAYS).toBe(45);
    expect(MIN_OBSERVED_DAYS).toBe(30);
  });

  it('passes at exactly 30 observed days and fails at 29', () => {
    expect(coldStart(calendar('L'.repeat(30) + '.'.repeat(15)), END)).toMatchObject({ observedDays: 30, passes: true });
    expect(coldStart(calendar('L'.repeat(29) + '.'.repeat(16)), END)).toMatchObject({ observedDays: 29, passes: false });
  });

  it('fails when nothing at all was logged', () => {
    expect(coldStart([], END)).toMatchObject({ observedDays: 0, observedDates: [], passes: false });
  });

  it('counts calendar days, not rows: 20 rows in 45 days is 20 observed days', () => {
    const gate = coldStart(calendar('L'.repeat(20) + '.'.repeat(25)), END);
    expect(gate).toMatchObject({ days: 45, observedDays: 20, passes: false });
  });

  it('does not count a row whose events were all deleted', () => {
    // 30 rows, but 5 of them unobserved: 25 observed days.
    const gate = coldStart(calendar('L'.repeat(25) + 'u'.repeat(5) + '.'.repeat(15)), END);
    expect(gate).toMatchObject({ observedDays: 25, passes: false });
  });

  it('counts a logged day with zero meals: an observed zero is still an observed day', () => {
    const days = calendar('L'.repeat(30) + '.'.repeat(15)).map((day) => ({
      ...day,
      values: { ...day.values, meals_logged: 0 },
    }));
    expect(coldStart(days, END)).toMatchObject({ observedDays: 30, passes: true });
  });

  it('ignores rows outside the window', () => {
    const before = Array.from({ length: 40 }, (_, i) => logged(addLocalDays(START, -(i + 1))));
    const after = [logged(addLocalDays(END, 1))];
    expect(coldStart([...before, ...after], END)).toMatchObject({ observedDays: 0, passes: false });
  });

  it('refuses two summaries for one date, as the series layer does', () => {
    expect(() => observedDatesIn([logged(END), logged(END)], { from: START, to: END })).toThrow(/two summaries/);
  });
});

// ── The logging streak (D7, D14, D16 §3) ───────────────────────────────────────

describe('logging streak — gates', () => {
  it('uses the decided thresholds and a key the patterns table accepts', () => {
    expect(MIN_STREAK_DAYS).toBe(3);
    expect(LOGGING_STREAK_KEY.startsWith('streak:')).toBe(true); // chk_pattern_key_kind
  });

  it('rejects for cold start before looking at runs, however long the run', () => {
    const evaluation = assessStreak(calendar('.'.repeat(16) + 'L'.repeat(29)), END);
    expect(evaluation).toEqual({
      outcome: 'rejected',
      key: LOGGING_STREAK_KEY,
      reason: 'cold_start',
      observedDays: 29,
      longestRunLength: 29,
    });
  });

  it('rejects when 30 days were logged but no run reaches three', () => {
    // 15 × "logged, logged, gap": exactly 30 observed days, longest run 2.
    const evaluation = assessStreak(calendar('LL.'.repeat(15)), END);
    expect(evaluation).toMatchObject({ outcome: 'rejected', reason: 'no_streak', observedDays: 30, longestRunLength: 2 });
  });

  it('passes at a run of exactly three', () => {
    // 11 × "LLL." then one more logged day: 34 observed, longest run 3.
    const assessment = passed(assessStreak(calendar('LLL.'.repeat(11) + 'L'), END));
    expect(assessment.longestRun.length).toBe(3);
    expect(assessment.observedDays).toBe(34);
  });
});

describe('logging streak — what breaks a run', () => {
  // 30 logged days, then the day under test, then 14 logged days.
  const around = (gap: string) => calendar('L'.repeat(30) + gap + 'L'.repeat(14));

  it('an unobserved row breaks the run', () => {
    const assessment = passed(assessStreak(around('u'), END));
    expect(assessment.longestRun).toEqual({ length: 30, from: START, to: addLocalDays(START, 29) });
    expect(assessment.currentRun).toEqual({ length: 14, from: addLocalDays(START, 31), to: END });
  });

  it('a day with no summary row breaks the run — it is never bridged', () => {
    const assessment = passed(assessStreak(around('.'), END));
    expect(assessment.longestRun.length).toBe(30);
    expect(assessment.currentRun?.length).toBe(14);
  });

  it('a logged day with zero meals does not break it: it is an observed zero', () => {
    const days = around('L').map((day) => ({ ...day, values: { ...day.values, meals_logged: 0 } }));
    const assessment = passed(assessStreak(days, END));
    expect(assessment.longestRun).toEqual({ length: 45, from: START, to: END });
  });
});

describe('logging streak — start, continuation, break and reset', () => {
  // A history long enough that every window below clears cold start on its own.
  const history = (lastLogged: string, gaps: string[] = []) =>
    Array.from({ length: 60 }, (_, i) => addLocalDays(lastLogged, -i))
      .filter((date) => !gaps.includes(date))
      .map((date) => logged(date));

  it('start: a run that began inside the window is counted from its first day', () => {
    const gap = addLocalDays(END, -5);
    const assessment = passed(assessStreak(history(END, [gap]), END));
    expect(assessment.currentRun).toEqual({ length: 5, from: addLocalDays(END, -4), to: END });
  });

  it('continuation: one more logged closed day extends the current run by one', () => {
    const gap = addLocalDays(END, -5);
    const next = addLocalDays(END, 1);
    const today = passed(assessStreak(history(END, [gap]), END));
    const tomorrow = passed(assessStreak(history(next, [gap]), next));
    expect(tomorrow.currentRun!.length).toBe(today.currentRun!.length + 1);
    expect(tomorrow.currentRun!.from).toBe(today.currentRun!.from);
  });

  it('break: when the last closed day was not logged there is no current run', () => {
    const assessment = passed(assessStreak(history(addLocalDays(END, -1)), END));
    expect(assessment.currentRun).toBeNull();
    // The run that just ended is still the longest — the history is not erased.
    expect(assessment.longestRun.to).toBe(addLocalDays(END, -1));
  });

  it('reset: the first logged day after a break starts a new run at one', () => {
    const days = [...history(addLocalDays(END, -2)), logged(END)];
    const assessment = passed(assessStreak(days, END));
    expect(assessment.currentRun).toEqual({ length: 1, from: END, to: END });
  });

  it('a run under way when the window opens is counted from the window’s first day', () => {
    // 60 consecutive logged days, but the window is 45 of them.
    const assessment = passed(assessStreak(history(END), END));
    expect(assessment.longestRun).toEqual({ length: 45, from: START, to: END });
    expect(assessment.windowDays).toBe(45);
  });
});

describe('logging streak — calendar', () => {
  it('follows local dates across a month and year boundary', () => {
    const end = '2027-01-10';
    const days = Array.from({ length: 45 }, (_, i) => logged(addLocalDays(end, -i)));
    const assessment = passed(assessStreak(days, end));
    expect(assessment.longestRun).toEqual({ length: 45, from: '2026-11-27', to: end });
    expect(assessment.evidence).toContain('2026-12-31');
    expect(assessment.evidence).toContain('2027-01-01');
  });

  it('follows local dates across a leap day', () => {
    const end = '2028-03-10';
    const days = Array.from({ length: 45 }, (_, i) => logged(addLocalDays(end, -i)));
    const assessment = passed(assessStreak(days, end));
    expect(assessment.evidence).toEqual(expect.arrayContaining(['2028-02-28', '2028-02-29', '2028-03-01']));
    expect(assessment.longestRun.length).toBe(45);
  });
});

describe('logging streak — determinism and evidence', () => {
  it('on a tie, reports the most recent of the equal longest runs', () => {
    // Seven runs of 5, then a run of 2: the last run of 5 (from day 36) wins the tie.
    const assessment = passed(assessStreak(calendar('LLLLL.'.repeat(7) + 'LL.'), END));
    expect(assessment.longestRun.length).toBe(5);
    expect(assessment.longestRun.from).toBe(addLocalDays(START, 36));
  });

  it('evidence is exactly the longest run’s dates, oldest first', () => {
    const assessment = passed(assessStreak(calendar('L'.repeat(30) + '.' + 'L'.repeat(14)), END));
    expect(assessment.evidence).toHaveLength(assessment.longestRun.length);
    expect(assessment.evidence[0]).toBe(assessment.longestRun.from);
    expect(assessment.evidence.at(-1)).toBe(assessment.longestRun.to);
    expect([...assessment.evidence].sort()).toEqual(assessment.evidence);
  });

  it('gives the same answer for the same days in any input order, every time', () => {
    const days = calendar('LLLL.LLLLLLL.LLL.LLLLLLLLLL.LLLLL.LLLL.LLLL.L');
    const reversed = [...days].reverse();
    expect(assessStreak(reversed, END)).toEqual(assessStreak(days, END));
    expect(assessStreak(days, END)).toEqual(assessStreak(days, END));
  });

  it('on the seeded noise fixture it reports only what is true of it (D13)', () => {
    // 45 consecutive logged days of noise: the streak is a fact about the log, not an inference.
    const assessment = passed(assessStreak(noiseDays(20260930, START, 45), END));
    expect(assessment.longestRun).toEqual({ length: 45, from: START, to: END });
    expect(assessment.currentRun).toEqual(assessment.longestRun);
  });
});

// ── The family stays blocked ───────────────────────────────────────────────────

describe('frequency/streak family', () => {
  it('is registered, does not emit, and names what blocks it', () => {
    const family = DETECTOR_REGISTRY.frequency_streak;
    expect(family.kinds).toEqual(['frequency', 'streak']);
    expect(family.emits).toBe(false);
    expect(family.actionability).toBeNull();
    expect(family.spec).toMatch(/streak\.ts/);
  });

  it('a streak that passes every decided gate still produces no detector result', () => {
    const days = calendar('L'.repeat(45));
    expect(assessStreak(days, END).outcome).toBe('passes_decided_gates');

    const results = runApprovedDetectors(days, { correlation: windowEnding(END, 30) });
    expect(results.filter((result) => (result.kind as string) === 'streak')).toEqual([]);
    expect(results.every((result) => result.kind === 'correlation')).toBe(true);
  });
});
