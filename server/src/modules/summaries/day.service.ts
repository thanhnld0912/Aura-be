import { toLocalTime } from '../../lib/local-date.js';
import type { DailyEventsService } from '../daily-events/daily-events.service.js';
import type { DailyPlansService } from '../daily-plans/daily-plans.service.js';
import type { DailySummariesRepository, DailySummaryRow } from './daily-summaries.repository.js';

/**
 * Recomputes everything derived from one local day: reconciliation first, then the
 * summary that reads its result.
 *
 * This runs synchronously on every write (API_DESIGN.md §7). Both steps are cheap
 * indexed queries and **neither calls AI** — which is the whole point of materialising
 * summaries. Opening the Home tab then costs one indexed read and zero model calls
 * (ARCHITECTURE.md §7), and that is what keeps the cost model in DEPLOYMENT.md §9
 * honest rather than aspirational.
 *
 * The summary is derived, never authoritative. Every figure in it can be recomputed
 * from `daily_events`, `plan_items` and `checkins`; if they ever disagree, the source
 * tables are right and the summary is stale.
 */
export class DayService {
  constructor(
    private readonly plans: DailyPlansService,
    private readonly events: DailyEventsService,
    private readonly summaries: DailySummariesRepository,
  ) {}

  async refresh(userId: string, localDate: string, timeZone: string): Promise<DailySummaryRow> {
    // Order matters: adherence is read back out of `plan_items` below, so the plan has
    // to be reconciled before the summary is computed.
    await this.plans.reconcileDay(userId, localDate, timeZone);
    return this.recomputeSummary(userId, localDate, timeZone);
  }

  async recomputeSummary(
    userId: string,
    localDate: string,
    timeZone: string,
  ): Promise<DailySummaryRow> {
    const [stats, checkin, adherence] = await Promise.all([
      this.events.dayStats(userId, localDate),
      this.events.checkinForDay(userId, localDate),
      this.plansAdherence(userId, localDate),
    ]);

    return this.summaries.upsert(userId, localDate, {
      eventsLogged: stats.eventsLogged,
      mealsLogged: stats.mealsLogged,
      waterMl: String(stats.waterMl),
      sleepMinutes: stats.sleepMinutes,
      // Stored as `time`, so they must be the user's wall clock rather than UTC.
      firstMealTime: stats.firstMealAt ? toLocalTime(stats.firstMealAt, timeZone) : null,
      lastMealTime: stats.lastMealAt ? toLocalTime(stats.lastMealAt, timeZone) : null,
      bedtime: stats.bedtimeAt ? toLocalTime(stats.bedtimeAt, timeZone) : null,
      planAdherencePct: adherence,
      mood: checkin?.mood ?? null,
    });
    /**
     * Nutrition fields are deliberately left at their defaults. `total_kcal`,
     * `vegetable_servings`, `protein_servings` and `distinct_foods` have no source
     * until Phase 3 fills `meals` and `meal_items`, and inventing a number here is
     * exactly the anti-pattern NUTRITION_ARCHITECTURE.md §1 exists to prevent.
     */
  }

  private async plansAdherence(userId: string, localDate: string): Promise<string | null> {
    const adherence = await this.plans.adherenceFor(userId, localDate);
    if (!adherence) return null;
    return ((adherence.happened / adherence.resolved) * 100).toFixed(2);
  }

  getSummary(userId: string, localDate: string): Promise<DailySummaryRow | undefined> {
    return this.summaries.findByDate(userId, localDate);
  }
}
