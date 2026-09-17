import { selectPatternEvidence, type PatternEvidenceSource } from '../../insights/pattern-evidence.js';
import {
  buildWeeklyReport,
  DAYS_IN_WEEK,
  EMPTY_WEEK,
  type WeeklyRawData,
  type WeeklyReport,
} from '../../insights/weekly-report.js';
import type { WeeklyStoryGenerator } from '../../insights/weekly-story-generator.js';
import { buildWeeklyEvidence, type WeeklyStory } from '../../insights/weekly-story.js';
import { ProviderUnavailableError, ValidationError } from '../../lib/errors.js';
import { addLocalDays, dayOfWeek, startOfLocalWeek, todayIn } from '../../lib/local-date.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import type { CheckinsRepository } from '../checkins/checkins.repository.js';
import type { MealsRepository } from '../meals/meals.repository.js';
import type { UsersService } from '../users/users.service.js';
import type { InsightsRepository } from './insights.repository.js';

/**
 * Weekly insights: the facts, and on request the story written from them.
 *
 * Two operations with a hard line between them. `weeklyReport` is deterministic and
 * free — it is what "no AI on read" (AI_ARCHITECTURE.md §7) means for a week. The story
 * is a separate, explicit, rate-limited action, and it always carries the report it was
 * written from, so the figures and the prose arrive together and cannot disagree.
 *
 * Nothing is persisted. There is no `weekly_summaries` table yet, and a cache of
 * generated prose is a schema-design decision rather than something to improvise in a
 * JSON column; the `ai-heavy` rate limit bounds what regeneration can cost meanwhile.
 */

export type WeeklyStoryStatus = 'ready' | 'insufficient_data' | 'disabled';

export interface WeeklyStoryResult {
  status: WeeklyStoryStatus;
  report: WeeklyReport;
  story: WeeklyStory | null;
}

export interface InsightsServiceDeps {
  repository: InsightsRepository;
  meals: Pick<MealsRepository, 'nutritionByDay'>;
  checkins: Pick<CheckinsRepository, 'listRange'>;
  users: Pick<UsersService, 'getProfile'>;
  patterns: PatternEvidenceSource;
  /** Absent when no Anthropic key is configured; the story then answers 503. */
  storyGenerator?: WeeklyStoryGenerator | undefined;
  /** Injected for tests, as `CheckinsService` does with its clock. */
  now?: () => Date;
}

interface ResolvedWeek {
  weekStart: string;
  today: string;
}

export class InsightsService {
  private readonly now: () => Date;

  constructor(private readonly deps: InsightsServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** `GET /api/insights/weekly`. No model call, ever. */
  async weeklyReport(user: AuthenticatedUser, weekStart?: string): Promise<WeeklyReport> {
    return this.buildReport(user, this.resolveWeek(user.timezone, weekStart));
  }

  /**
   * `POST /api/insights/weekly/story`.
   *
   * Three outcomes that are not a story, each decided before anything is spent: the user
   * has turned AI insights off; the week has too little data to say anything honest
   * about; or no reasoning provider is configured. Only the last is an error.
   */
  async weeklyStory(user: AuthenticatedUser, weekStart?: string): Promise<WeeklyStoryResult> {
    const week = this.resolveWeek(user.timezone, weekStart);
    const [report, profile] = await Promise.all([
      this.buildReport(user, week),
      this.deps.users.getProfile(user.id),
    ]);

    // An opt-out is honoured before the model is even considered (`ai_insights_enabled`).
    if (!profile.preferences.aiInsightsEnabled) return { status: 'disabled', report, story: null };

    // AURA says nothing rather than something premature (PATTERN_ENGINE.md §7).
    if (report.coverage.status === 'insufficient_data') {
      return { status: 'insufficient_data', report, story: null };
    }

    if (!this.deps.storyGenerator) {
      throw new ProviderUnavailableError('Weekly stories are not available right now');
    }

    const evidence = buildWeeklyEvidence(report, {
      locale: profile.user.locale,
      goalFocus: profile.preferences.goalFocus,
    });
    const story = await this.deps.storyGenerator.generate(evidence, { userId: user.id });
    return { status: 'ready', report, story };
  }

  /**
   * A week is named by its Monday, in the user's calendar. Omitted means the week that
   * contains today; a week that has not started yet has no facts to report.
   */
  private resolveWeek(timezone: string, requested: string | undefined): ResolvedWeek {
    const today = todayIn(timezone, this.now());
    const currentWeek = startOfLocalWeek(today);

    if (requested === undefined) return { weekStart: currentWeek, today };

    // The shared date schema lets `2026-02-30` through (V8's `Date.parse` rolls it over),
    // and it would pass the Monday check below as the 2 March it rolls to — then fail in
    // Postgres as a 500. A real calendar date survives a round trip unchanged.
    if (addLocalDays(requested, 0) !== requested) {
      throw new ValidationError('weekStart must be a real calendar date', [
        { path: 'weekStart', issue: 'invalid_date' },
      ]);
    }

    if (dayOfWeek(requested) !== 1) {
      throw new ValidationError('weekStart must be a Monday', [
        { path: 'weekStart', issue: 'not_a_week_start' },
      ]);
    }
    if (requested > currentWeek) {
      throw new ValidationError('weekStart must not be a future week', [
        { path: 'weekStart', issue: 'future_week' },
      ]);
    }
    return { weekStart: requested, today };
  }

  private async buildReport(user: AuthenticatedUser, week: ResolvedWeek): Promise<WeeklyReport> {
    const previousWeekStart = addLocalDays(week.weekStart, -DAYS_IN_WEEK);
    const weekEnd = addLocalDays(week.weekStart, DAYS_IN_WEEK - 1);

    const [current, previous, candidates] = await Promise.all([
      this.loadWeek(user.id, week.weekStart, week.today),
      this.loadWeek(user.id, previousWeekStart, week.today),
      this.deps.patterns.forPeriod(user.id, { from: week.weekStart, to: weekEnd }),
    ]);

    return buildWeeklyReport({
      weekStart: week.weekStart,
      today: week.today,
      timezone: user.timezone,
      current,
      previous,
      patterns: selectPatternEvidence(candidates),
    });
  }

  /**
   * One week's grouped rows. Bounded at today: a day that has not happened has nothing
   * to read, and querying it would only invite a future-dated row into a figure.
   */
  private async loadWeek(userId: string, weekStart: string, today: string): Promise<WeeklyRawData> {
    const weekEnd = addLocalDays(weekStart, DAYS_IN_WEEK - 1);
    const to = weekEnd < today ? weekEnd : today;
    if (to < weekStart) return EMPTY_WEEK;

    const { repository, meals, checkins } = this.deps;
    const [events, mealDays, distinctFoods, planItems, workouts, habitLogs, checkinRows] =
      await Promise.all([
        repository.eventsByDay(userId, weekStart, to),
        // Reused rather than rewritten: confirmed meals only, drafts excluded, in SQL.
        meals.nutritionByDay(userId, weekStart, to),
        repository.distinctFoods(userId, weekStart, to),
        repository.planItemsByDay(userId, weekStart, to),
        repository.workoutsByDay(userId, weekStart, to),
        repository.habitLogsByDay(userId, weekStart, to),
        checkins.listRange(userId, weekStart, to),
      ]);

    return {
      events,
      meals: mealDays.map(({ localDate, mealsLogged, unresolvedItems }) => ({
        localDate,
        mealsLogged,
        unresolvedItems,
      })),
      distinctFoods,
      planItems,
      workouts,
      habitLogs,
      // Mood, tag and energy only. The check-in note is free text a person wrote; it is
      // not a figure, and it never enters a report or a prompt.
      checkins: checkinRows.map((row) => ({
        localDate: String(row.localDate),
        mood: row.mood,
        dayTag: row.dayTag,
        energy: row.energy1to5,
      })),
    };
  }
}
