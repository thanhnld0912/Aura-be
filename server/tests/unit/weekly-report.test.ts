import { describe, expect, it } from 'vitest';
import {
  buildWeeklyReport,
  EMPTY_WEEK,
  type WeeklyRawData,
  type WeeklyReportInput,
} from '../../src/insights/weekly-report.js';
import { addLocalDays, dayOfWeek, startOfLocalWeek } from '../../src/lib/local-date.js';

/**
 * The deterministic weekly report (no model, no database).
 *
 * Every figure a weekly story may narrate is pinned here first, from fixed rows. The
 * rule most of these tests exist for: **nothing logged is not zero**.
 */

const WEEK = '2026-09-07'; // a Monday
const WEEK_OVER = '2026-09-14'; // the Monday after: every day of WEEK has closed
const TZ = 'Asia/Ho_Chi_Minh';

const day = (offset: number): string => addLocalDays(WEEK, offset);
const previousDay = (offset: number): string => addLocalDays(WEEK, offset - 7);

function raw(overrides: Partial<WeeklyRawData> = {}): WeeklyRawData {
  return { ...EMPTY_WEEK, ...overrides };
}

/** A day on which something was logged. */
function logged(date: string, extra: Partial<WeeklyRawData['events'][number]> = {}) {
  return { localDate: date, total: 2, walks: 0, sleepMinutes: null, ...extra };
}

function build(
  current: WeeklyRawData,
  options: Partial<Omit<WeeklyReportInput, 'current' | 'weekStart'>> = {},
) {
  return buildWeeklyReport({
    weekStart: WEEK,
    today: options.today ?? WEEK_OVER,
    timezone: TZ,
    current,
    previous: options.previous ?? EMPTY_WEEK,
    patterns: options.patterns ?? { status: 'unavailable', items: [] },
  });
}

describe('week helpers', () => {
  it('numbers weekdays ISO-style, Monday 1 to Sunday 7', () => {
    expect(dayOfWeek('2026-09-07')).toBe(1);
    expect(dayOfWeek('2026-09-13')).toBe(7);
    expect(dayOfWeek('2026-09-10')).toBe(4);
  });

  it('finds the Monday of a week from any of its days, across month and year edges', () => {
    expect(startOfLocalWeek('2026-09-07')).toBe('2026-09-07');
    expect(startOfLocalWeek('2026-09-13')).toBe('2026-09-07');
    expect(startOfLocalWeek('2026-09-14')).toBe('2026-09-14');
    expect(startOfLocalWeek('2026-10-01')).toBe('2026-09-28');
    expect(startOfLocalWeek('2027-01-01')).toBe('2026-12-28');
  });
});

describe('weekly report — period and coverage', () => {
  it('reports a complete week of seven tracked days as sufficient', () => {
    const report = build(raw({ events: [0, 1, 2, 3, 4, 5, 6].map((offset) => logged(day(offset))) }));

    expect(report.period).toEqual({
      weekStart: '2026-09-07',
      weekEnd: '2026-09-13',
      timezone: TZ,
      daysInPeriod: 7,
      daysElapsed: 7,
      isComplete: true,
    });
    expect(report.coverage).toEqual({ daysTracked: 7, daysElapsed: 7, rate: 1, status: 'sufficient' });
    expect(report.days.every((entry) => entry.tracked === true)).toBe(true);
    expect(report.dataQuality.limitations).not.toContain('week_in_progress');
  });

  it('marks a missing day as untracked, with no event count rather than a zero', () => {
    const report = build(raw({ events: [0, 1, 3, 4, 5, 6].map((offset) => logged(day(offset))) }));

    expect(report.coverage).toMatchObject({ daysTracked: 6, daysElapsed: 7, rate: 0.86 });
    expect(report.days[2]).toEqual({
      localDate: '2026-09-09',
      elapsed: true,
      tracked: false,
      eventsLogged: null,
      mealsLogged: null,
      mood: null,
    });
  });

  it('treats a week in progress as partial: future days are not missing', () => {
    const report = build(
      raw({
        events: [logged(day(0)), logged(day(1)), logged(day(2)), logged(day(5))],
        meals: [{ localDate: day(5), mealsLogged: 3, unresolvedItems: 0 }],
      }),
      { today: day(2) }, // Wednesday
    );

    expect(report.period).toMatchObject({ daysElapsed: 3, isComplete: false });
    expect(report.coverage).toMatchObject({ daysTracked: 3, daysElapsed: 3, rate: 1 });
    // A row dated after today cannot count — it has not happened yet.
    expect(report.nutrition.status).toBe('no_data');
    expect(report.days[5]).toMatchObject({ elapsed: false, tracked: null, eventsLogged: null });
    expect(report.dataQuality.limitations).toContain('week_in_progress');
  });

  it('does not call a week complete while its Sunday is still today', () => {
    const report = build(raw({ events: [logged(day(6))] }), { today: day(6) });
    expect(report.period).toMatchObject({ daysElapsed: 7, isComplete: false });
  });

  it('flags a week with too few tracked days as insufficient', () => {
    const report = build(raw({ events: [logged(day(0)), logged(day(4))] }));

    expect(report.coverage.status).toBe('insufficient_data');
    expect(report.dataQuality.limitations).toContain('insufficient_logging_coverage');
  });

  it('ignores rows from either neighbouring week', () => {
    const report = build(
      raw({
        events: [logged('2026-09-06'), logged(day(0)), logged('2026-09-14')],
        checkins: [{ localDate: '2026-09-14', mood: 'great', dayTag: null, energy: 5 }],
      }),
      { today: '2026-09-20' },
    );

    expect(report.coverage.daysTracked).toBe(1);
    expect(report.checkins.status).toBe('no_data');
  });
});

describe('weekly report — missing is not zero', () => {
  it('reports no meal logs as no_data with null behaviour figures', () => {
    const report = build(raw({ events: [0, 1, 2, 3].map((offset) => logged(day(offset))) }));

    expect(report.nutrition).toEqual({
      status: 'no_data',
      daysWithConfirmedMeals: 0,
      coverage: 0,
      confirmedMeals: null,
      averageMealsPerLoggedDay: null,
      distinctFoods: null,
      itemsNeedingReview: null,
    });
    // A tracked day with no meal log is unknown for meals, not "0 meals".
    expect(report.days[0]).toMatchObject({ tracked: true, mealsLogged: null });
    expect(report.dataQuality.limitations).toContain('no_meal_logs');
  });

  it('averages meals over days with meal logs, never over seven', () => {
    const report = build(
      raw({
        events: [logged(day(0)), logged(day(1))],
        meals: [
          { localDate: day(0), mealsLogged: 3, unresolvedItems: 1 },
          { localDate: day(1), mealsLogged: 1, unresolvedItems: 0 },
        ],
        distinctFoods: 5,
      }),
    );

    expect(report.nutrition).toEqual({
      status: 'ok',
      daysWithConfirmedMeals: 2,
      coverage: 0.29,
      confirmedMeals: 4,
      averageMealsPerLoggedDay: 2,
      distinctFoods: 5,
      itemsNeedingReview: 1,
    });
    expect(report.dataQuality.limitations).toContain('meal_items_unresolved');
  });

  it('reports no workouts or walks as unknown activity, not as inactivity', () => {
    const report = build(raw({ events: [logged(day(0))] }));

    expect(report.activity).toEqual({ status: 'no_data', activeDays: 0, walks: null, workoutSessions: null });
    expect(report.dataQuality.limitations).toContain('no_activity_logs');
  });

  it('keeps a true zero inside data that exists', () => {
    const report = build(
      raw({
        events: [logged(day(0), { walks: 1 })],
        workouts: [{ localDate: day(1), status: 'completed', count: 1 }],
      }),
    );

    // Sessions were logged, none of them skipped: that 0 is a fact about the log.
    expect(report.activity).toEqual({
      status: 'ok',
      activeDays: 2,
      walks: 1,
      workoutSessions: { completed: 1, partial: 0, skipped: 0 },
    });
  });

  it('reports no habit logs as null, not as a skipped habit', () => {
    const report = build(raw({ events: [logged(day(0))] }));
    expect(report.habits).toEqual({
      status: 'no_data',
      daysWithLogs: 0,
      trackedHabits: null,
      logs: null,
      completionRate: null,
    });
  });

  it('computes habit completion over the logs that exist', () => {
    const report = build(
      raw({
        habitLogs: [
          { localDate: day(0), habitId: 'h1', status: 'done', count: 1 },
          { localDate: day(1), habitId: 'h1', status: 'skipped', count: 1 },
          { localDate: day(1), habitId: 'h2', status: 'done', count: 1 },
          { localDate: day(2), habitId: 'h2', status: 'partial', count: 1 },
        ],
      }),
    );

    expect(report.habits).toEqual({
      status: 'ok',
      daysWithLogs: 3,
      trackedHabits: 2,
      logs: { done: 2, partial: 1, skipped: 1 },
      completionRate: 0.5,
    });
  });

  it('summarises check-ins, averaging energy only where it was recorded', () => {
    const report = build(
      raw({
        checkins: [
          { localDate: day(0), mood: 'good', dayTag: 'busy', energy: 4 },
          { localDate: day(1), mood: 'okay', dayTag: null, energy: null },
          { localDate: day(2), mood: 'good', dayTag: 'normal', energy: 3 },
        ],
      }),
    );

    expect(report.checkins).toEqual({
      status: 'ok',
      daysWithCheckin: 3,
      moodCounts: { low: 0, okay: 1, good: 2, great: 0 },
      dayTagCounts: { normal: 1, busy: 1, better_than_expected: 0, not_as_planned: 0 },
      averageEnergy: 3.5,
      energySamples: 2,
    });
    expect(report.days[0]?.mood).toBe('good');
  });

  it('averages sleep over nights that were logged', () => {
    const report = build(
      raw({
        events: [
          logged(day(0), { sleepMinutes: 420 }),
          logged(day(1)),
          logged(day(2), { sleepMinutes: 460 }),
        ],
      }),
    );
    expect(report.sleep).toEqual({ status: 'ok', daysWithSleep: 2, averageSleepMinutes: 440 });
  });
});

describe('weekly report — planned vs actual', () => {
  it('counts on_time, shifted and substituted as happened, over resolved items only', () => {
    const report = build(
      raw({
        planItems: [
          { localDate: day(0), eventType: 'workout', adherence: 'on_time', count: 1 },
          { localDate: day(1), eventType: 'workout', adherence: 'substituted', count: 1 },
          { localDate: day(1), eventType: 'meal', adherence: 'shifted', count: 1 },
          { localDate: day(2), eventType: 'walk', adherence: 'not_logged', count: 1 },
          { localDate: day(2), eventType: 'sleep', adherence: 'on_time', count: 1 },
        ],
      }),
    );

    expect(report.plan).toEqual({
      status: 'ok',
      daysWithPlan: 3,
      plannedItems: 5,
      resolvedItems: 5,
      happenedItems: 4,
      pendingItems: 0,
      adherenceRate: 0.8,
      byAdherence: { pending: 0, on_time: 2, shifted: 1, substituted: 1, not_logged: 1 },
      activity: { planned: 3, resolved: 3, happened: 2, rate: 0.67 },
    });
  });

  it('resolves items still pending on a closed day as not_logged, as reconcile() would', () => {
    const report = build(
      raw({
        planItems: [
          { localDate: day(0), eventType: 'walk', adherence: 'on_time', count: 1 },
          { localDate: day(1), eventType: 'walk', adherence: 'pending', count: 2 },
          { localDate: day(2), eventType: 'walk', adherence: 'pending', count: 1 },
        ],
      }),
      { today: day(2) },
    );

    // Tuesday is over, so its two items are not_logged; Wednesday is today, so its item
    // is still pending and is left out of the rate rather than counted against anyone.
    expect(report.plan).toMatchObject({
      plannedItems: 4,
      resolvedItems: 3,
      happenedItems: 1,
      pendingItems: 1,
      adherenceRate: 0.33,
      byAdherence: { pending: 1, on_time: 1, shifted: 0, substituted: 0, not_logged: 2 },
    });
  });

  it('reports a week without plans as no_data', () => {
    const report = build(raw({ events: [logged(day(0))] }));
    expect(report.plan.status).toBe('no_data');
    expect(report.plan.adherenceRate).toBeNull();
    expect(report.dataQuality.limitations).toContain('no_plans');
  });
});

describe('weekly report — previous week', () => {
  const tracked = (days: (offset: number) => string, offsets: number[]) =>
    offsets.map((offset) => logged(days(offset)));

  it('compares rates when both weeks carry enough data', () => {
    const report = build(raw({ events: tracked(day, [0, 1, 2, 3, 4, 5]) }), {
      previous: raw({ events: tracked(previousDay, [0, 2, 4]) }),
    });

    const logging = report.comparison.metrics.find((metric) => metric.metric === 'logging_coverage');
    expect(report.comparison.status).toBe('available');
    expect(report.comparison.previousWeekStart).toBe('2026-08-31');
    expect(logging).toEqual({
      metric: 'logging_coverage',
      status: 'available',
      current: 0.86,
      previous: 0.43,
      delta: 0.43,
      direction: 'up',
    });
  });

  it('calls a small change flat, and a fall down', () => {
    const flat = build(raw({ events: tracked(day, [0, 1, 2, 3]) }), {
      previous: raw({ events: tracked(previousDay, [0, 1, 2, 3]) }),
    });
    const down = build(raw({ events: tracked(day, [0, 1, 2]) }), {
      previous: raw({ events: tracked(previousDay, [0, 1, 2, 3, 4, 5, 6]) }),
    });

    expect(flat.comparison.metrics[0]).toMatchObject({ delta: 0, direction: 'flat' });
    expect(down.comparison.metrics[0]).toMatchObject({ direction: 'down', delta: -0.57 });
  });

  it('refuses to compare against a previous week with too little data', () => {
    const report = build(raw({ events: tracked(day, [0, 1, 2, 3, 4]) }), {
      previous: raw({ events: tracked(previousDay, [0, 1]) }),
    });

    expect(report.comparison.status).toBe('insufficient_data');
    for (const metric of report.comparison.metrics) {
      expect(metric.status).toBe('insufficient_data');
      expect(metric.delta).toBeNull();
      expect(metric.direction).toBeNull();
    }
    expect(report.dataQuality.limitations).toContain('previous_week_insufficient');
  });

  it('reports no comparison at all when the previous week has no logs', () => {
    const report = build(raw({ events: tracked(day, [0, 1, 2, 3, 4]) }));

    expect(report.comparison.status).toBe('unavailable');
    expect(report.comparison.metrics.every((metric) => metric.previous === null)).toBe(true);
    expect(report.dataQuality.limitations).toContain('previous_week_unavailable');
  });

  it('needs enough resolved plan items on both sides to compare adherence', () => {
    const plan = (days: (offset: number) => string, count: number) => [
      { localDate: days(0), eventType: 'walk' as const, adherence: 'on_time' as const, count },
    ];
    const report = build(raw({ events: tracked(day, [0, 1, 2]), planItems: plan(day, 5) }), {
      previous: raw({ events: tracked(previousDay, [0, 1, 2]), planItems: plan(previousDay, 2) }),
    });

    const adherence = report.comparison.metrics.find((metric) => metric.metric === 'plan_adherence');
    expect(adherence).toMatchObject({ status: 'insufficient_data', current: 1, previous: 1, delta: null });
  });
});

describe('weekly report — determinism and patterns', () => {
  it('produces the same report from the same rows', () => {
    const input = raw({
      events: [logged(day(0), { walks: 1, sleepMinutes: 400 }), logged(day(3))],
      meals: [{ localDate: day(0), mealsLogged: 2, unresolvedItems: 0 }],
      distinctFoods: 3,
    });
    expect(build(input)).toEqual(build(structuredClone(input)));
  });

  it('passes pattern evidence through unchanged and discloses an absent engine', () => {
    const none = build(raw(), { patterns: { status: 'none', items: [] } });
    const unavailable = build(raw());

    expect(none.patterns).toEqual({ status: 'none', items: [] });
    expect(none.dataQuality.limitations).not.toContain('pattern_engine_unavailable');
    expect(unavailable.dataQuality.limitations).toContain('pattern_engine_unavailable');
  });
});
