import { EvidenceCollector, sanitizeDisplayText, screenInput, type EvidenceItem } from '../../ai/safety/index.js';
import type { AgentScope, IntentClassification } from '../../agent/intent.js';
import { DAYS_IN_WEEK } from '../../insights/weekly-report.js';
import { buildWeeklyEvidence, type GoalFocus } from '../../insights/weekly-story.js';
import { NotFoundError } from '../../lib/errors.js';
import { addLocalDays, dayOfWeek, startOfLocalWeek, toLocalDate, toLocalTime, todayIn } from '../../lib/local-date.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import type { DailyEventsService } from '../daily-events/daily-events.service.js';
import type { DailyPlansService } from '../daily-plans/daily-plans.service.js';
import type { InsightsService } from '../insights/insights.service.js';
import type { MealsRepository, MealWithItems } from '../meals/meals.repository.js';
import type { MealsService } from '../meals/meals.service.js';

/**
 * The records a chat reply may draw on, as citable statements.
 *
 * ## The rules this class keeps
 *
 * - **Only existing read paths.** Meals through `MealsService`, nutrition through the
 *   same confirmed-only aggregate `/nutrition/daily` uses, plans through the comparison
 *   `/daily-plan/comparison` serves, a week through `InsightsService.weeklyReport` and
 *   Task 7's `buildWeeklyEvidence`. Nothing here re-derives a figure another module owns.
 * - **Only the authenticated user.** Every read takes `user.id` from the verified token;
 *   the message never contributes an id, a date string or a filter.
 * - **Only what the intent needs.** A meal question reads meals; a general question reads
 *   nothing at all. Lists are capped.
 * - **No identifiers.** No ids, emails or timestamps reach a statement. Free text a person
 *   wrote — plan titles, event titles, food names — is sanitised, stripped of angle
 *   brackets, clipped, and replaced outright if it trips the input gate. Check-in notes
 *   are never read.
 * - **Missing is not zero.** A gap becomes a limitation that says so, never a 0.
 *
 * Reconciliation note: `DailyPlansService.comparison` reconciles before answering, exactly
 * as the comparison endpoint does, so the answer reflects the current state. That write is
 * idempotent.
 */

export interface AgentReader {
  locale: 'vi' | 'en';
  goalFocus: GoalFocus;
  showCalories: boolean;
}

export type AgentPeriod =
  | { kind: 'day'; label: 'today' | 'yesterday' }
  | { kind: 'week'; label: 'this week' | 'last week'; complete: boolean }
  | null;

export interface AgentContext {
  items: EvidenceItem[];
  /** Which kinds of record were read, e.g. `meals:today`. Auditable, and free of ids. */
  usedContext: string[];
  period: AgentPeriod;
}

export interface AgentContextDeps {
  meals: Pick<MealsService, 'listForDay'>;
  mealsRepository: Pick<MealsRepository, 'nutritionByDay' | 'mealTypesByDay'>;
  plans: Pick<DailyPlansService, 'comparison'>;
  events: Pick<DailyEventsService, 'listForDay' | 'checkinForDay'>;
  insights: Pick<InsightsService, 'weeklyReport'>;
  now?: () => Date;
}

/** The context budget. Past these, a list is summarised as a count. */
export const CONTEXT_LIMITS = {
  items: 40,
  meals: 6,
  foodsPerMeal: 6,
  drafts: 3,
  planItems: 10,
  events: 10,
  labelChars: 60,
} as const;

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const ACTIVITY_TYPES: ReadonlySet<string> = new Set(['walk', 'workout', 'sleep']);

const round1 = (value: number): number => Math.round(value * 10) / 10;
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * Text a person wrote, made fit for a statement: sanitised, no angle brackets (so it
 * cannot close a fence), no double quotes (so it cannot close its own quotation), clipped,
 * and replaced by a neutral label if it looks like an instruction or a disclosure.
 */
export function safeLabel(text: string | null | undefined, fallback: string): string {
  const cleaned = text ? sanitizeDisplayText(text.replace(/[<>"]/g, ' ')) : null;
  if (!cleaned) return fallback;
  if (screenInput(cleaned, 'chat').action === 'block') return fallback;
  return cleaned.length > CONTEXT_LIMITS.labelChars
    ? `${cleaned.slice(0, CONTEXT_LIMITS.labelChars - 3)}...`
    : cleaned;
}

export class AgentContextBuilder {
  private readonly now: () => Date;

  constructor(private readonly deps: AgentContextDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async build(
    user: AuthenticatedUser,
    reader: AgentReader,
    classification: IntentClassification,
  ): Promise<AgentContext> {
    const evidence = new EvidenceCollector();
    const usedContext: string[] = [];
    const { scope, topics } = classification;
    const today = todayIn(user.timezone, this.now());

    let period: AgentPeriod = null;

    if (scope.kind === 'day') {
      const date = scope.day === 'today' ? today : addLocalDays(today, -1);
      period = { kind: 'day', label: scope.day };
      const run = new DayContext(this.deps, user, reader, date, scope.day, evidence, usedContext);

      if (topics.length === 0) {
        await run.overview();
      } else {
        if (topics.includes('meals') || topics.includes('nutrition')) {
          await run.meals();
          await run.nutrition();
        }
        if (topics.includes('plan')) await run.plan();
        if (topics.includes('activity')) await run.activity();
        if (topics.includes('checkins')) await run.checkin();
      }
    } else if (scope.kind === 'week') {
      period = await this.week(user, reader, scope, today, topics.includes('meals'), evidence, usedContext);
    }

    return { items: evidence.items.slice(0, CONTEXT_LIMITS.items), usedContext, period };
  }

  /** A week: Task 7's deterministic report and evidence, reused rather than re-derived. */
  private async week(
    user: AuthenticatedUser,
    reader: AgentReader,
    scope: Extract<AgentScope, { kind: 'week' }>,
    today: string,
    withMealTypes: boolean,
    evidence: EvidenceCollector,
    usedContext: string[],
  ): Promise<AgentPeriod> {
    const currentWeek = startOfLocalWeek(today);
    const weekStart = scope.week === 'last' ? addLocalDays(currentWeek, -DAYS_IN_WEEK) : currentWeek;
    const label = scope.week === 'last' ? 'last week' : 'this week';

    const report = await this.deps.insights.weeklyReport(user, weekStart);
    for (const item of buildWeeklyEvidence(report, reader).items) {
      evidence.add({
        kind: item.kind,
        source: item.source,
        statement: item.statement,
        ...(item.caveat !== undefined ? { caveat: item.caveat } : {}),
        ...(item.patternId !== undefined ? { patternId: item.patternId } : {}),
      });
    }
    usedContext.push(`weekly_report:${label.replace(' ', '_')}`);

    if (withMealTypes && report.nutrition.status === 'ok') {
      const weekEnd = addLocalDays(weekStart, DAYS_IN_WEEK - 1);
      const to = weekEnd < today ? weekEnd : today;
      const rows = await this.deps.mealsRepository.mealTypesByDay(user.id, weekStart, to);
      const dates = report.days.filter((day) => day.elapsed).map((day) => day.localDate);
      const names = (list: string[]) => list.map((date) => WEEKDAY_NAMES[dayOfWeek(date) - 1]).join(', ');
      const soFar = report.period.isComplete ? '' : ' so far';

      for (const mealType of ['breakfast', 'lunch', 'dinner'] as const) {
        const logged = dates.filter((date) =>
          rows.some((row) => row.localDate === date && row.mealType === mealType && row.count > 0),
        );
        const unlogged = dates.filter((date) => !logged.includes(date));
        evidence.add({
          kind: 'fact',
          source: `metric:meals.${mealType}_days`,
          statement: `Days with a confirmed ${mealType} logged: ${logged.length > 0 ? names(logged) : 'none'} (${logged.length} of ${dates.length} days${soFar})`,
        });
        if (unlogged.length > 0) {
          evidence.add({
            kind: 'fact',
            source: `metric:meals.${mealType}_unlogged_days`,
            statement: `Days with no ${mealType} logged: ${names(unlogged)}. Not logged does not show it was skipped`,
          });
        }
      }
      usedContext.push(`meal_types:${label.replace(' ', '_')}`);
    }

    return { kind: 'week', label, complete: report.period.isComplete };
  }
}

/** One day's readers, sharing the date, the reader settings and the collector. */
class DayContext {
  constructor(
    private readonly deps: AgentContextDeps,
    private readonly user: AuthenticatedUser,
    private readonly reader: AgentReader,
    private readonly date: string,
    private readonly dayWord: 'today' | 'yesterday',
    private readonly evidence: EvidenceCollector,
    private readonly usedContext: string[],
  ) {}

  private fact(source: string, statement: string): void {
    this.evidence.add({ kind: 'fact', source, statement });
  }

  private limitation(source: string, statement: string): void {
    this.evidence.add({ kind: 'limitation', source, statement });
  }

  /** "How is my day going?" — counts, the plan and the check-in; no food detail. */
  async overview(): Promise<void> {
    const events = await this.deps.events.listForDay(this.user.id, this.date);
    this.usedContext.push(`events:${this.dayWord}`);

    if (events.length === 0) {
      this.limitation('limitation:nothing_logged', `Nothing is logged for ${this.dayWord}, so the day is unknown, not empty.`);
    } else {
      const counts = new Map<string, number>();
      for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      const parts = [...counts.entries()].map(([type, count]) => plural(count, type === 'checkin' ? 'check-in' : type));
      this.fact('metric:events.day_counts', `Logged ${this.dayWord}: ${parts.join(', ')}`);
    }

    await this.plan();
    await this.checkin();
  }

  async meals(): Promise<void> {
    const all = await this.deps.meals.listForDay(this.user.id, this.date, true);
    this.usedContext.push(`meals:${this.dayWord}`);

    const confirmed = all.filter((entry) => entry.meal.status === 'confirmed');
    // `includeDrafts` returns drafts from any day; only the ones started on this date count.
    const drafts = all.filter(
      (entry) => entry.meal.status === 'draft' && toLocalDate(entry.meal.createdAt, this.user.timezone) === this.date,
    );

    if (confirmed.length === 0) {
      this.limitation(
        'limitation:no_meal_logs',
        `No confirmed meals are logged for ${this.dayWord}, so what was eaten ${this.dayWord} is unknown, not zero.`,
      );
    } else {
      this.fact('metric:meals.confirmed_count', `${plural(confirmed.length, 'confirmed meal')} logged ${this.dayWord}`);
      for (const entry of confirmed.slice(0, CONTEXT_LIMITS.meals)) {
        const kcal = this.kcal(entry, 'estimated');
        this.fact('meal:confirmed', `Confirmed ${entry.meal.mealType}: ${this.foods(entry)}${kcal}`);
      }
      if (confirmed.length > CONTEXT_LIMITS.meals) {
        this.fact('meal:confirmed_more', `${plural(confirmed.length - CONTEXT_LIMITS.meals, 'more confirmed meal')} not listed`);
      }
    }

    for (const entry of drafts.slice(0, CONTEXT_LIMITS.drafts)) {
      const kcal = this.kcal(entry, 'draft estimate, not confirmed:');
      this.fact(
        'meal:draft',
        `Unconfirmed draft ${entry.meal.mealType}, not counted as eaten or in any total: ${this.foods(entry)}${kcal}`,
      );
    }
  }

  async nutrition(): Promise<void> {
    const [day] = await this.deps.mealsRepository.nutritionByDay(this.user.id, this.date, this.date);
    this.usedContext.push(`nutrition:${this.dayWord}`);

    if (!day) {
      this.limitation(
        'limitation:no_confirmed_nutrition',
        `There is no confirmed nutrition for ${this.dayWord}; unconfirmed drafts are never counted.`,
      );
      return;
    }

    const parts: string[] = [];
    if (this.reader.showCalories && day.kcal !== null) parts.push(`${Math.round(day.kcal)} kcal`);
    if (day.proteinG !== null) parts.push(`${round1(day.proteinG)} g protein`);
    if (day.carbsG !== null) parts.push(`${round1(day.carbsG)} g carbohydrate`);
    if (day.fatG !== null) parts.push(`${round1(day.fatG)} g fat`);
    if (day.fiberG !== null) parts.push(`${round1(day.fiberG)} g fibre`);

    if (parts.length > 0) {
      this.fact('metric:nutrition.day_totals', `Estimated nutrition from confirmed meals ${this.dayWord}: ${parts.join(', ')}`);
    }
    if (day.unresolvedItems > 0) {
      this.fact(
        'metric:nutrition.unresolved_items',
        `${plural(day.unresolvedItems, 'logged meal item')} could not be matched to the food database, so these totals are incomplete`,
      );
    }
    this.limitation('limitation:nutrition_estimate', 'Nutrition figures are estimates from typical portions, not measurements.');
    if (!this.reader.showCalories) {
      this.limitation('limitation:calories_hidden', 'This person has chosen not to see calorie figures; do not mention calories.');
    }
  }

  async plan(): Promise<void> {
    this.usedContext.push(`plan:${this.dayWord}`);

    let comparison;
    try {
      comparison = await this.deps.plans.comparison(this.user.id, this.date, this.user.timezone);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      this.limitation('limitation:no_plan', `There is no daily plan for ${this.dayWord}.`);
      return;
    }

    const resolved = comparison.items.filter((item) => item.adherence !== 'pending');
    const happened = resolved.filter((item) => item.actual !== null);
    const pending = comparison.items.filter((item) => item.adherence === 'pending');

    if (resolved.length > 0 && comparison.adherencePct !== null) {
      this.fact(
        'metric:plan.day_adherence',
        `${happened.length} of ${resolved.length} resolved plan items ${this.dayWord} happened (${comparison.adherencePct}%)`,
      );
    }
    if (pending.length > 0) {
      this.fact('metric:plan.day_pending', `${plural(pending.length, 'plan item')} ${this.dayWord} not logged yet`);
    }

    for (const item of comparison.items.slice(0, CONTEXT_LIMITS.planItems)) {
      const title = safeLabel(item.planned.title, item.planned.type);
      const actual = item.actual;
      const outcome =
        item.adherence === 'on_time' && actual
          ? `done on time, logged at ${actual.time}`
          : item.adherence === 'shifted' && actual
            ? `done at a different time, logged at ${actual.time}`
            : item.adherence === 'substituted' && actual
              ? `done as a similar activity (${actual.type} at ${actual.time})`
              : item.adherence === 'pending'
                ? 'not logged yet'
                : 'not logged';
      this.fact('plan:item', `Planned ${item.planned.type} "${title}" at ${item.planned.time}: ${outcome}`);
    }
    if (comparison.items.length > CONTEXT_LIMITS.planItems) {
      this.fact('plan:item_more', `${plural(comparison.items.length - CONTEXT_LIMITS.planItems, 'more plan item')} not listed`);
    }

    for (const extra of comparison.unplanned.slice(0, 5)) {
      this.fact('event:unplanned', `Also logged without a plan: ${extra.type} "${safeLabel(extra.title, extra.type)}" at ${extra.time}`);
    }
  }

  async activity(): Promise<void> {
    const events = (await this.deps.events.listForDay(this.user.id, this.date)).filter((event) =>
      ACTIVITY_TYPES.has(event.type),
    );
    this.usedContext.push(`activity:${this.dayWord}`);

    if (events.length === 0) {
      this.limitation(
        'limitation:no_activity_logs',
        `No walks, workouts or sleep are logged for ${this.dayWord}, so activity ${this.dayWord} is unknown, not zero.`,
      );
      return;
    }

    for (const event of events.slice(0, CONTEXT_LIMITS.events)) {
      const duration = event.durationMin !== null ? `, ${event.durationMin} min` : '';
      this.fact(
        'event:activity',
        `Logged ${event.type} "${safeLabel(event.title, event.type)}" at ${toLocalTime(event.occurredAt, this.user.timezone)}${duration}`,
      );
    }
    if (events.length > CONTEXT_LIMITS.events) {
      this.fact('event:activity_more', `${plural(events.length - CONTEXT_LIMITS.events, 'more activity log')} not listed`);
    }
  }

  async checkin(): Promise<void> {
    const checkin = await this.deps.events.checkinForDay(this.user.id, this.date);
    this.usedContext.push(`checkin:${this.dayWord}`);

    if (!checkin) {
      this.limitation('limitation:no_checkin', `No check-in is logged for ${this.dayWord}, so mood and energy ${this.dayWord} are unknown.`);
      return;
    }
    // Mood, energy and tag only. The note is free text a person wrote and is never read.
    const energy = checkin.energy1to5 !== null ? `, energy ${checkin.energy1to5} on a 1 to 5 scale` : '';
    const tag = checkin.dayTag ? `, day tag "${checkin.dayTag.replace(/_/g, ' ')}"` : '';
    this.fact('checkin:day', `Check-in ${this.dayWord}: mood ${checkin.mood}${energy}${tag}`);
  }

  private foods(entry: MealWithItems): string {
    const names = [...entry.items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) =>
        safeLabel(
          (this.reader.locale === 'en' ? item.displayNameEn : item.displayNameVi) ?? item.detectedName,
          'a food item',
        ),
      );
    const shown = names.slice(0, CONTEXT_LIMITS.foodsPerMeal).join(', ');
    const more = names.length - CONTEXT_LIMITS.foodsPerMeal;
    return more > 0 ? `${shown} and ${plural(more, 'more item')}` : shown || 'no items';
  }

  /** A meal total as text, only when the person has calories on and a total exists. */
  private kcal(entry: MealWithItems, label: string): string {
    if (!this.reader.showCalories || entry.meal.totalKcal === null) return '';
    return ` (${label} ${Math.round(Number(entry.meal.totalKcal))} kcal)`;
  }
}
