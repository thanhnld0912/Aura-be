import type {
  adherenceEnum,
  dayTagEnum,
  eventTypeEnum,
  habitLogStatusEnum,
  moodEnum,
  workoutStatusEnum,
} from '../database/schema/enums.js';
import { addLocalDays } from '../lib/local-date.js';
import type { PatternEvidence, PatternSelectionStatus } from './pattern-evidence.js';

/**
 * A week of someone's logs, turned into facts — deterministically, and without a model.
 *
 * ## The rule this module exists to keep
 *
 * **Nothing logged is not zero.** A Wednesday with no meal in it says the meal log is
 * empty, not that nobody ate; a week with no workout says nothing was *logged*. So every
 * section here separates two kinds of number:
 *
 * - **coverage** — how many days had a log of this kind. These are real counts about
 *   the log itself, and a 0 is true: "0 of 7 days had a confirmed meal".
 * - **behaviour** — how many meals, what completion rate, what average. These exist
 *   only where there is data. With no data the section is `no_data` and every
 *   behaviour figure is `null`, never 0, so no consumer (and no narrator) can be handed
 *   "0 meals" to repeat.
 *
 * ## Why it is pure
 *
 * The repository fetches grouped rows; this function does everything else. Same rows in,
 * same report out — no clock, no database — so every rule here is tested with fixed
 * inputs, and the story built on top narrates figures a test has already pinned.
 */

type EnumValue<T extends { enumValues: readonly string[] }> = T['enumValues'][number];

export type EventType = EnumValue<typeof eventTypeEnum>;
export type Adherence = EnumValue<typeof adherenceEnum>;
export type WorkoutStatus = EnumValue<typeof workoutStatusEnum>;
export type HabitLogStatus = EnumValue<typeof habitLogStatusEnum>;
export type Mood = EnumValue<typeof moodEnum>;
export type DayTag = EnumValue<typeof dayTagEnum>;

export const DAYS_IN_WEEK = 7;

/**
 * Fewer tracked days than this and a week is not representative: no story is generated,
 * and it is not compared with anything. Three of seven is the smallest week in which a
 * "usually" is not a single day repeated.
 */
export const MIN_TRACKED_DAYS = 3;

/** Resolved plan items or habit logs needed on *each* side before a rate is compared. */
export const MIN_COMPARISON_SAMPLE = 3;

/**
 * A change in a rate smaller than this is reported as `flat`. Presentation, not
 * statistics: a week-on-week delta is not a significance test, and pretending otherwise
 * is the Pattern Engine's job to refuse, not this module's to attempt.
 */
export const FLAT_DELTA = 0.1;

export const LIMITATION_CODES = [
  'week_in_progress',
  'insufficient_logging_coverage',
  'no_meal_logs',
  'meal_items_unresolved',
  'no_activity_logs',
  'no_plans',
  'no_habit_logs',
  'no_checkins',
  'no_sleep_logs',
  'pattern_engine_unavailable',
  'previous_week_unavailable',
  'previous_week_insufficient',
] as const;

export type LimitationCode = (typeof LIMITATION_CODES)[number];

export const COMPARISON_METRICS = [
  'logging_coverage',
  'meal_logging_coverage',
  'plan_adherence',
  'habit_completion',
] as const;

export type ComparisonMetricKey = (typeof COMPARISON_METRICS)[number];
export type ComparisonStatus = 'available' | 'insufficient_data' | 'unavailable';
export type SectionStatus = 'ok' | 'no_data';

// ── Input: grouped rows, exactly as the repository returns them ───────────────

export interface WeeklyRawData {
  events: Array<{ localDate: string; total: number; walks: number; sleepMinutes: number | null }>;
  /** Confirmed meals only — a draft did not happen (DATABASE_DESIGN.md §3.4). */
  meals: Array<{ localDate: string; mealsLogged: number; unresolvedItems: number }>;
  distinctFoods: number;
  planItems: Array<{ localDate: string; eventType: EventType; adherence: Adherence; count: number }>;
  workouts: Array<{ localDate: string; status: WorkoutStatus; count: number }>;
  habitLogs: Array<{ localDate: string; habitId: string; status: HabitLogStatus; count: number }>;
  checkins: Array<{ localDate: string; mood: Mood; dayTag: DayTag | null; energy: number | null }>;
}

export const EMPTY_WEEK: WeeklyRawData = {
  events: [],
  meals: [],
  distinctFoods: 0,
  planItems: [],
  workouts: [],
  habitLogs: [],
  checkins: [],
};

export interface WeeklyReportInput {
  /** A Monday, in the user's calendar. The caller validates it. */
  weekStart: string;
  /** Today in the user's timezone. Days after it have not happened and are not "missing". */
  today: string;
  timezone: string;
  current: WeeklyRawData;
  previous: WeeklyRawData;
  patterns: { status: PatternSelectionStatus; items: PatternEvidence[] };
}

// ── Output ─────────────────────────────────────────────────────────────────────

export interface WeeklyDay {
  localDate: string;
  /** False for days later than today — not missing, just not yet. */
  elapsed: boolean;
  /** Whether anything at all was logged. `null` for a day that has not happened. */
  tracked: boolean | null;
  eventsLogged: number | null;
  /** `null` means no confirmed meal was logged — unknown, never "ate nothing". */
  mealsLogged: number | null;
  mood: Mood | null;
}

export interface NutritionSection {
  status: SectionStatus;
  daysWithConfirmedMeals: number;
  coverage: number | null;
  confirmedMeals: number | null;
  averageMealsPerLoggedDay: number | null;
  distinctFoods: number | null;
  itemsNeedingReview: number | null;
}

export interface ActivitySection {
  status: SectionStatus;
  /** Days with a logged walk, or a completed or partial workout session. */
  activeDays: number;
  walks: number | null;
  workoutSessions: { completed: number; partial: number; skipped: number } | null;
}

export interface PlanTally {
  planned: number;
  resolved: number;
  happened: number;
  /** `happened / resolved`. Pending items are excluded, not counted against anyone. */
  rate: number | null;
}

export interface PlanSection {
  status: SectionStatus;
  daysWithPlan: number;
  plannedItems: number | null;
  resolvedItems: number | null;
  happenedItems: number | null;
  pendingItems: number | null;
  adherenceRate: number | null;
  byAdherence: Record<Adherence, number> | null;
  /** The plan items that were a workout or a walk, when there were any. */
  activity: PlanTally | null;
}

export interface HabitsSection {
  status: SectionStatus;
  daysWithLogs: number;
  trackedHabits: number | null;
  logs: Record<HabitLogStatus, number> | null;
  completionRate: number | null;
}

export interface CheckinsSection {
  status: SectionStatus;
  daysWithCheckin: number;
  moodCounts: Record<Mood, number> | null;
  dayTagCounts: Record<DayTag, number> | null;
  averageEnergy: number | null;
  energySamples: number | null;
}

export interface SleepSection {
  status: SectionStatus;
  daysWithSleep: number;
  averageSleepMinutes: number | null;
}

export interface ComparisonMetric {
  metric: ComparisonMetricKey;
  status: ComparisonStatus;
  current: number | null;
  previous: number | null;
  delta: number | null;
  direction: 'up' | 'down' | 'flat' | null;
}

export interface WeeklyReport {
  period: {
    weekStart: string;
    weekEnd: string;
    timezone: string;
    daysInPeriod: number;
    daysElapsed: number;
    /** True only once the week's Sunday is over in the user's timezone. */
    isComplete: boolean;
  };
  coverage: {
    daysTracked: number;
    daysElapsed: number;
    rate: number | null;
    status: 'sufficient' | 'insufficient_data';
  };
  days: WeeklyDay[];
  nutrition: NutritionSection;
  activity: ActivitySection;
  plan: PlanSection;
  habits: HabitsSection;
  checkins: CheckinsSection;
  sleep: SleepSection;
  comparison: {
    previousWeekStart: string;
    status: ComparisonStatus;
    metrics: ComparisonMetric[];
  };
  patterns: { status: PatternSelectionStatus; items: PatternEvidence[] };
  dataQuality: { limitations: LimitationCode[] };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
/** A share, or `null` when there is nothing to divide by — never a 0 standing in for "n/a". */
const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? round(numerator / denominator, 2) : null;

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

const ADHERENCE: readonly Adherence[] = ['pending', 'on_time', 'shifted', 'substituted', 'not_logged'];
const HAPPENED: ReadonlySet<Adherence> = new Set(['on_time', 'shifted', 'substituted']);
const ACTIVITY_TYPES: ReadonlySet<EventType> = new Set(['workout', 'walk']);
const MOODS: readonly Mood[] = ['low', 'okay', 'good', 'great'];
const DAY_TAGS: readonly DayTag[] = ['normal', 'busy', 'better_than_expected', 'not_as_planned'];
const HABIT_STATUSES: readonly HabitLogStatus[] = ['done', 'partial', 'skipped'];

type WeekFigures = Omit<WeeklyReport, 'comparison' | 'patterns' | 'dataQuality'>;

// ── The report ─────────────────────────────────────────────────────────────────

export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const previousWeekStart = addLocalDays(input.weekStart, -DAYS_IN_WEEK);

  const current = summarise(input.weekStart, input.today, input.timezone, input.current);
  // The previous week is always over by the time this one has started.
  const previous = summarise(previousWeekStart, input.today, input.timezone, input.previous);
  const comparison = compare(current, previous, previousWeekStart);

  return {
    ...current,
    comparison,
    patterns: input.patterns,
    dataQuality: { limitations: limitationsOf(current, comparison.status, input.patterns.status) },
  };
}

function summarise(weekStart: string, today: string, timezone: string, raw: WeeklyRawData): WeekFigures {
  const weekEnd = addLocalDays(weekStart, DAYS_IN_WEEK - 1);
  const dates = Array.from({ length: DAYS_IN_WEEK }, (_, index) => addLocalDays(weekStart, index));
  const elapsed = new Set(dates.filter((date) => date <= today));
  const daysElapsed = elapsed.size;

  // Defensive: the repository already bounds its range, but a row outside the elapsed
  // week must never leak into a figure about it.
  const within = <T extends { localDate: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => elapsed.has(row.localDate));

  // ── Logging coverage ──
  const events = within(raw.events).filter((row) => row.total > 0);
  const eventsByDate = new Map(events.map((row) => [row.localDate, row]));
  const daysTracked = events.length;

  // ── Nutrition ──
  const mealDays = within(raw.meals).filter((row) => row.mealsLogged > 0);
  const mealsByDate = new Map(mealDays.map((row) => [row.localDate, row.mealsLogged]));
  const confirmedMeals = sum(mealDays.map((row) => row.mealsLogged));

  const nutrition: NutritionSection =
    mealDays.length === 0
      ? {
          status: 'no_data',
          daysWithConfirmedMeals: 0,
          coverage: ratio(0, daysElapsed),
          confirmedMeals: null,
          averageMealsPerLoggedDay: null,
          distinctFoods: null,
          itemsNeedingReview: null,
        }
      : {
          status: 'ok',
          daysWithConfirmedMeals: mealDays.length,
          coverage: ratio(mealDays.length, daysElapsed),
          confirmedMeals,
          // Over days that *have* meal logs, never over seven: dividing by unlogged days
          // would describe the tracking, not the eating (API_DESIGN.md §20).
          averageMealsPerLoggedDay: round(confirmedMeals / mealDays.length, 1),
          distinctFoods: raw.distinctFoods,
          itemsNeedingReview: sum(mealDays.map((row) => row.unresolvedItems)),
        };

  // ── Activity ──
  const walks = sum(events.map((row) => row.walks));
  const sessions = within(raw.workouts).filter((row) => row.count > 0);
  const sessionCounts = { completed: 0, partial: 0, skipped: 0 };
  for (const row of sessions) sessionCounts[row.status] += row.count;

  const activeDates = new Set([
    ...events.filter((row) => row.walks > 0).map((row) => row.localDate),
    ...sessions.filter((row) => row.status !== 'skipped').map((row) => row.localDate),
  ]);

  const activity: ActivitySection =
    walks === 0 && sessions.length === 0
      ? { status: 'no_data', activeDays: 0, walks: null, workoutSessions: null }
      : { status: 'ok', activeDays: activeDates.size, walks, workoutSessions: sessionCounts };

  // ── Plan vs actual ──
  const planRows = within(raw.planItems)
    .filter((row) => row.count > 0)
    .map((row) => ({
      ...row,
      /**
       * Reconciliation only runs when something is written, so a day that ended with an
       * unmatched item and no later write still says `pending` in `plan_items`. For a
       * closed day that item is `not_logged` — which is precisely what `reconcile()`
       * returns once `dayClosed` is true. Applied here so a weekly figure does not quietly
       * drop the items of the days nobody touched afterwards.
       */
      adherence: row.adherence === 'pending' && row.localDate < today ? ('not_logged' as const) : row.adherence,
    }));

  const tally = (rows: typeof planRows) => {
    const byAdherence = zeroed(ADHERENCE);
    for (const row of rows) byAdherence[row.adherence] += row.count;
    const planned = sum(rows.map((row) => row.count));
    const resolved = planned - byAdherence.pending;
    const happened = sum(rows.filter((row) => HAPPENED.has(row.adherence)).map((row) => row.count));
    return { byAdherence, planned, resolved, happened, rate: ratio(happened, resolved) };
  };

  const planTotals = tally(planRows);
  const activityRows = planRows.filter((row) => ACTIVITY_TYPES.has(row.eventType));
  const activityTotals = tally(activityRows);

  const plan: PlanSection =
    planRows.length === 0
      ? {
          status: 'no_data',
          daysWithPlan: 0,
          plannedItems: null,
          resolvedItems: null,
          happenedItems: null,
          pendingItems: null,
          adherenceRate: null,
          byAdherence: null,
          activity: null,
        }
      : {
          status: 'ok',
          daysWithPlan: new Set(planRows.map((row) => row.localDate)).size,
          plannedItems: planTotals.planned,
          resolvedItems: planTotals.resolved,
          happenedItems: planTotals.happened,
          pendingItems: planTotals.byAdherence.pending,
          adherenceRate: planTotals.rate,
          byAdherence: planTotals.byAdherence,
          activity:
            activityRows.length === 0
              ? null
              : {
                  planned: activityTotals.planned,
                  resolved: activityTotals.resolved,
                  happened: activityTotals.happened,
                  rate: activityTotals.rate,
                },
        };

  // ── Habits ──
  const habitRows = within(raw.habitLogs).filter((row) => row.count > 0);
  const habitCounts = zeroed(HABIT_STATUSES);
  for (const row of habitRows) habitCounts[row.status] += row.count;

  const habits: HabitsSection =
    habitRows.length === 0
      ? { status: 'no_data', daysWithLogs: 0, trackedHabits: null, logs: null, completionRate: null }
      : {
          status: 'ok',
          daysWithLogs: new Set(habitRows.map((row) => row.localDate)).size,
          trackedHabits: new Set(habitRows.map((row) => row.habitId)).size,
          logs: habitCounts,
          // Of the logs that exist. A habit nobody logged is not a habit that was skipped.
          completionRate: ratio(habitCounts.done, sum(Object.values(habitCounts))),
        };

  // ── Check-ins ──
  const checkinRows = within(raw.checkins);
  const moodByDate = new Map(checkinRows.map((row) => [row.localDate, row.mood]));
  const energies = checkinRows.flatMap((row) => (row.energy === null ? [] : [row.energy]));

  let checkins: CheckinsSection;
  if (checkinRows.length === 0) {
    checkins = {
      status: 'no_data',
      daysWithCheckin: 0,
      moodCounts: null,
      dayTagCounts: null,
      averageEnergy: null,
      energySamples: null,
    };
  } else {
    const moodCounts = zeroed(MOODS);
    const dayTagCounts = zeroed(DAY_TAGS);
    for (const row of checkinRows) {
      moodCounts[row.mood] += 1;
      if (row.dayTag !== null) dayTagCounts[row.dayTag] += 1;
    }
    checkins = {
      status: 'ok',
      daysWithCheckin: checkinRows.length,
      moodCounts,
      dayTagCounts,
      averageEnergy: energies.length > 0 ? round(sum(energies) / energies.length, 1) : null,
      energySamples: energies.length,
    };
  }

  // ── Sleep ──
  const sleepDays = events.flatMap((row) =>
    row.sleepMinutes !== null && row.sleepMinutes > 0 ? [row.sleepMinutes] : [],
  );
  const sleep: SleepSection =
    sleepDays.length === 0
      ? { status: 'no_data', daysWithSleep: 0, averageSleepMinutes: null }
      : {
          status: 'ok',
          daysWithSleep: sleepDays.length,
          averageSleepMinutes: Math.round(sum(sleepDays) / sleepDays.length),
        };

  return {
    period: {
      weekStart,
      weekEnd,
      timezone,
      daysInPeriod: DAYS_IN_WEEK,
      daysElapsed,
      isComplete: weekEnd < today,
    },
    coverage: {
      daysTracked,
      daysElapsed,
      rate: ratio(daysTracked, daysElapsed),
      status: daysTracked >= MIN_TRACKED_DAYS ? 'sufficient' : 'insufficient_data',
    },
    days: dates.map((localDate) => {
      const isElapsed = elapsed.has(localDate);
      const logged = eventsByDate.get(localDate)?.total ?? 0;
      return {
        localDate,
        elapsed: isElapsed,
        tracked: isElapsed ? logged > 0 : null,
        eventsLogged: isElapsed && logged > 0 ? logged : null,
        mealsLogged: mealsByDate.get(localDate) ?? null,
        mood: moodByDate.get(localDate) ?? null,
      };
    }),
    nutrition,
    activity,
    plan,
    habits,
    checkins,
    sleep,
  };
}

// ── Previous week ──────────────────────────────────────────────────────────────

/**
 * Week-on-week, for rates only.
 *
 * Counts are never compared: a week in progress has fewer days in it, and "fewer walks
 * than last week" on a Wednesday is arithmetic about the calendar. A rate is comparable,
 * and only when both weeks have enough under it — otherwise the answer is
 * `insufficient_data`, and a previous week with no logs at all is `unavailable`, because
 * there is nothing on the other side to be better or worse than.
 */
function compare(current: WeekFigures, previous: WeekFigures, previousWeekStart: string) {
  const enoughDays =
    current.coverage.daysTracked >= MIN_TRACKED_DAYS && previous.coverage.daysTracked >= MIN_TRACKED_DAYS;

  const candidates: Array<[ComparisonMetricKey, number | null, number | null, boolean]> = [
    ['logging_coverage', current.coverage.rate, previous.coverage.rate, enoughDays],
    ['meal_logging_coverage', current.nutrition.coverage, previous.nutrition.coverage, enoughDays],
    [
      'plan_adherence',
      current.plan.adherenceRate,
      previous.plan.adherenceRate,
      (current.plan.resolvedItems ?? 0) >= MIN_COMPARISON_SAMPLE &&
        (previous.plan.resolvedItems ?? 0) >= MIN_COMPARISON_SAMPLE,
    ],
    [
      'habit_completion',
      current.habits.completionRate,
      previous.habits.completionRate,
      habitLogCount(current) >= MIN_COMPARISON_SAMPLE && habitLogCount(previous) >= MIN_COMPARISON_SAMPLE,
    ],
  ];

  if (previous.coverage.daysTracked === 0) {
    return {
      previousWeekStart,
      status: 'unavailable' as const,
      metrics: candidates.map(([metric, currentValue]) => ({
        metric,
        status: 'unavailable' as const,
        current: currentValue,
        previous: null,
        delta: null,
        direction: null,
      })),
    };
  }

  const metrics: ComparisonMetric[] = candidates.map(([metric, currentValue, previousValue, enough]) => {
    if (!enough || currentValue === null || previousValue === null) {
      return { metric, status: 'insufficient_data', current: currentValue, previous: previousValue, delta: null, direction: null };
    }
    const delta = round(currentValue - previousValue, 2);
    return {
      metric,
      status: 'available',
      current: currentValue,
      previous: previousValue,
      delta,
      direction: Math.abs(delta) < FLAT_DELTA ? 'flat' : delta > 0 ? 'up' : 'down',
    };
  });

  return {
    previousWeekStart,
    status: metrics.some((metric) => metric.status === 'available')
      ? ('available' as const)
      : ('insufficient_data' as const),
    metrics,
  };
}

function habitLogCount(week: WeekFigures): number {
  return week.habits.logs ? sum(Object.values(week.habits.logs)) : 0;
}

function limitationsOf(
  week: WeekFigures,
  comparison: ComparisonStatus,
  patterns: PatternSelectionStatus,
): LimitationCode[] {
  const limitations: LimitationCode[] = [];
  if (!week.period.isComplete) limitations.push('week_in_progress');
  if (week.coverage.status === 'insufficient_data') limitations.push('insufficient_logging_coverage');
  if (week.nutrition.status === 'no_data') limitations.push('no_meal_logs');
  else if ((week.nutrition.itemsNeedingReview ?? 0) > 0) limitations.push('meal_items_unresolved');
  if (week.activity.status === 'no_data') limitations.push('no_activity_logs');
  if (week.plan.status === 'no_data') limitations.push('no_plans');
  if (week.habits.status === 'no_data') limitations.push('no_habit_logs');
  if (week.checkins.status === 'no_data') limitations.push('no_checkins');
  if (week.sleep.status === 'no_data') limitations.push('no_sleep_logs');
  if (patterns === 'unavailable') limitations.push('pattern_engine_unavailable');
  if (comparison === 'unavailable') limitations.push('previous_week_unavailable');
  else if (comparison === 'insufficient_data') limitations.push('previous_week_insufficient');
  return limitations;
}
