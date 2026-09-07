import { and, eq } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { dailySummaries } from '../../database/schema/index.js';

export type DailySummaryRow = typeof dailySummaries.$inferSelect;

export interface SummaryValues {
  eventsLogged: number;
  mealsLogged: number;
  waterMl: string;
  sleepMinutes: number | null;
  firstMealTime: string | null;
  lastMealTime: string | null;
  bedtime: string | null;
  planAdherencePct: string | null;
  mood: DailySummaryRow['mood'];
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
}
