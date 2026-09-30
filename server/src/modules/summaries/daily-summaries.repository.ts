import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import {
  dailyEvents,
  dailyPlans,
  dailySummaries,
  mealItems,
  meals,
  planItems,
  workoutSessions,
} from '../../database/schema/index.js';
import type { WorkoutStatus } from '../../patterns/day-facts.js';

export type DailySummaryRow = typeof dailySummaries.$inferSelect;

export interface SummaryValues {
  eventsLogged: number;
  mealsLogged: number;
  /** Null when nothing measured it — see the note on `dailySummaries`. */
  waterMl: string | null;
  distinctFoods: number | null;
  vegetableServings: number | null;
  proteinServings: number | null;
  sleepMinutes: number | null;
  firstMealTime: string | null;
  lastMealTime: string | null;
  bedtime: string | null;
  planAdherencePct: string | null;
  mood: DailySummaryRow['mood'];
  metrics: Record<string, number | null>;
}

/**
 * The raw rows behind the Pattern Engine's derived day facts (`patterns/day-facts.ts`).
 * Rows only — what they mean is decided by the pure functions there.
 */
export interface DayFactRows {
  /** Every live event's instant on the local day. */
  eventInstants: Date[];
  /** Statuses of the workout sessions attached to the day's live events. */
  workoutStatuses: WorkoutStatus[];
  /** `planned_time` of the day's planned workouts, in minutes past local midnight. */
  plannedWorkoutMinutes: number[];
  /** Distinct resolved foods across the day's confirmed meals. */
  distinctResolvedFoods: number;
}

export class DailySummariesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Upsert on `(user_id, local_date)` — the unique index does the concurrency work, so
   * two writes landing at once produce one row rather than a duplicate or an error.
   */
  async upsert(
    userId: string,
    localDate: string,
    values: SummaryValues,
  ): Promise<DailySummaryRow> {
    const [row] = await this.db
      .insert(dailySummaries)
      .values({ userId, localDate, ...values, computedAt: new Date() })
      .onConflictDoUpdate({
        target: [dailySummaries.userId, dailySummaries.localDate],
        // Only the recomputed columns. `narrative` and `ai_run_id` are written by
        // Phase 5 and must survive a recompute — regenerating a day's counts is not a
        // reason to throw away the sentence Claude wrote about it.
        set: { ...values, computedAt: new Date() },
      })
      .returning();

    if (!row) throw new Error('summary upsert returned no row');
    return row;
  }

  async findByDate(userId: string, localDate: string): Promise<DailySummaryRow | undefined> {
    return this.db.query.dailySummaries.findFirst({
      where: and(eq(dailySummaries.userId, userId), eq(dailySummaries.localDate, localDate)),
    });
  }

  /** The user's summaries in an inclusive local-date range, oldest first. Days without a row are absent. */
  async findRange(userId: string, from: string, to: string): Promise<DailySummaryRow[]> {
    return this.db
      .select()
      .from(dailySummaries)
      .where(
        and(
          eq(dailySummaries.userId, userId),
          gte(dailySummaries.localDate, from),
          lte(dailySummaries.localDate, to),
        ),
      )
      .orderBy(asc(dailySummaries.localDate));
  }

  /**
   * The source rows for one day's derived facts. Scoped by `user_id` on every table, and to
   * live rows only: a deleted event, meal or its workout is not part of the day.
   */
  async dayFacts(userId: string, localDate: string): Promise<DayFactRows> {
    const liveEventOnDay = and(
      eq(dailyEvents.userId, userId),
      eq(dailyEvents.localDate, localDate),
      isNull(dailyEvents.deletedAt),
    );

    const [instants, workouts, planned, foods] = await Promise.all([
      this.db
        // Epoch seconds, not the timestamptz: see `DailyEventsRepository.dayStats`.
        .select({ epoch: sql<number>`extract(epoch from ${dailyEvents.occurredAt})::float8` })
        .from(dailyEvents)
        .where(liveEventOnDay),
      this.db
        .select({ status: workoutSessions.status })
        .from(workoutSessions)
        .innerJoin(dailyEvents, eq(workoutSessions.eventId, dailyEvents.id))
        .where(and(eq(workoutSessions.userId, userId), liveEventOnDay)),
      this.db
        .select({
          minutes: sql<number>`(extract(hour from ${planItems.plannedTime}) * 60
            + extract(minute from ${planItems.plannedTime}))::int`,
        })
        .from(planItems)
        .innerJoin(dailyPlans, eq(planItems.planId, dailyPlans.id))
        .where(
          and(
            eq(dailyPlans.userId, userId),
            eq(dailyPlans.localDate, localDate),
            eq(planItems.eventType, 'workout'),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(distinct ${mealItems.foodId})::int` })
        .from(meals)
        .innerJoin(dailyEvents, eq(meals.eventId, dailyEvents.id))
        .innerJoin(mealItems, eq(mealItems.mealId, meals.id))
        .where(
          and(eq(meals.userId, userId), eq(meals.status, 'confirmed'), isNull(meals.deletedAt), liveEventOnDay),
        ),
    ]);

    return {
      eventInstants: instants.map((row) => new Date(row.epoch * 1000)),
      workoutStatuses: workouts.map((row) => row.status),
      plannedWorkoutMinutes: planned.map((row) => row.minutes),
      distinctResolvedFoods: foods[0]?.count ?? 0,
    };
  }
}
