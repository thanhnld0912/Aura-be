import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import {
  dailyEvents,
  dailyPlans,
  habitLogs,
  mealItems,
  meals,
  planItems,
  workoutSessions,
} from '../../database/schema/index.js';
import type { WeeklyRawData } from '../../insights/weekly-report.js';

/**
 * The grouped reads behind a weekly report.
 *
 * Every query is aggregated in SQL and grouped by local day, so a week costs a fixed
 * handful of indexed reads — never one query per day and never a load of raw rows into
 * memory. Grouping is by the stored `local_date`, which was derived from the user's
 * timezone when the row was written (DATABASE_DESIGN.md §1.6); no UTC truncation happens
 * here, so there is nothing here to get wrong about midnight.
 *
 * Like every repository, each method takes `userId` first and filters on it.
 */
export class InsightsRepository {
  constructor(private readonly db: Db) {}

  /** Event counts per day. Soft-deleted events did not happen. */
  async eventsByDay(userId: string, from: string, to: string): Promise<WeeklyRawData['events']> {
    const rows = await this.db
      .select({
        localDate: dailyEvents.localDate,
        total: sql<number>`count(*)::int`,
        walks: sql<number>`count(*) filter (where ${dailyEvents.type} = 'walk')::int`,
        sleepMinutes: sql<number | null>`
          sum(${dailyEvents.durationMin}) filter (where ${dailyEvents.type} = 'sleep')::int`,
      })
      .from(dailyEvents)
      .where(
        and(
          eq(dailyEvents.userId, userId),
          gte(dailyEvents.localDate, from),
          lte(dailyEvents.localDate, to),
          isNull(dailyEvents.deletedAt),
        ),
      )
      .groupBy(dailyEvents.localDate);

    return rows.map((row) => ({ ...row, localDate: String(row.localDate) }));
  }

  /**
   * Distinct foods across confirmed meals in the range. A separate query because a
   * per-day distinct count cannot be summed into a weekly one.
   */
  async distinctFoods(userId: string, from: string, to: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(distinct ${mealItems.foodId})::int` })
      .from(meals)
      .innerJoin(dailyEvents, eq(meals.eventId, dailyEvents.id))
      .innerJoin(mealItems, eq(mealItems.mealId, meals.id))
      .where(
        and(
          eq(meals.userId, userId),
          eq(meals.status, 'confirmed'),
          isNull(meals.deletedAt),
          isNull(dailyEvents.deletedAt),
          gte(dailyEvents.localDate, from),
          lte(dailyEvents.localDate, to),
        ),
      );

    return rows[0]?.count ?? 0;
  }

  /**
   * Plan items per day, type and adherence. Ownership runs through the parent plan,
   * exactly as the plans repository and the RLS policy scope it.
   */
  async planItemsByDay(userId: string, from: string, to: string): Promise<WeeklyRawData['planItems']> {
    const rows = await this.db
      .select({
        localDate: dailyPlans.localDate,
        eventType: planItems.eventType,
        adherence: planItems.adherence,
        count: sql<number>`count(*)::int`,
      })
      .from(planItems)
      .innerJoin(dailyPlans, eq(planItems.planId, dailyPlans.id))
      .where(
        and(
          eq(dailyPlans.userId, userId),
          gte(dailyPlans.localDate, from),
          lte(dailyPlans.localDate, to),
        ),
      )
      .groupBy(dailyPlans.localDate, planItems.eventType, planItems.adherence);

    return rows.map((row) => ({ ...row, localDate: String(row.localDate) }));
  }

  /** Workout sessions per day and status, dated by their event. */
  async workoutsByDay(userId: string, from: string, to: string): Promise<WeeklyRawData['workouts']> {
    const rows = await this.db
      .select({
        localDate: dailyEvents.localDate,
        status: workoutSessions.status,
        count: sql<number>`count(*)::int`,
      })
      .from(workoutSessions)
      .innerJoin(dailyEvents, eq(workoutSessions.eventId, dailyEvents.id))
      .where(
        and(
          eq(workoutSessions.userId, userId),
          eq(dailyEvents.userId, userId),
          isNull(dailyEvents.deletedAt),
          gte(dailyEvents.localDate, from),
          lte(dailyEvents.localDate, to),
        ),
      )
      .groupBy(dailyEvents.localDate, workoutSessions.status);

    return rows.map((row) => ({ ...row, localDate: String(row.localDate) }));
  }

  /**
   * Habit logs per day, habit and status. Archived habits are included: archiving hides
   * a habit going forward and never rewrites the history already logged.
   */
  async habitLogsByDay(userId: string, from: string, to: string): Promise<WeeklyRawData['habitLogs']> {
    const rows = await this.db
      .select({
        localDate: habitLogs.localDate,
        habitId: habitLogs.habitId,
        status: habitLogs.status,
        count: sql<number>`count(*)::int`,
      })
      .from(habitLogs)
      .where(
        and(
          eq(habitLogs.userId, userId),
          gte(habitLogs.localDate, from),
          lte(habitLogs.localDate, to),
        ),
      )
      .groupBy(habitLogs.localDate, habitLogs.habitId, habitLogs.status);

    return rows.map((row) => ({ ...row, localDate: String(row.localDate) }));
  }
}
