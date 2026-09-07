import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { dailyPlans, planItems } from '../../database/schema/index.js';
import type { ReconciledItem } from './reconciliation.js';

/**
 * The only layer that touches `daily_plans` and `plan_items` (ARCHITECTURE.md §5).
 *
 * `plan_items` carries no `user_id`; ownership runs through `plan_id`, so every query
 * here joins or scopes via the parent plan. A plan item is never addressable without
 * its plan, and a plan is never addressable without its owner.
 */

export type DailyPlanRow = typeof dailyPlans.$inferSelect;
export type PlanItemRow = typeof planItems.$inferSelect;

export interface PlanWithItems {
  plan: DailyPlanRow;
  items: PlanItemRow[];
}

export interface PlanItemInput {
  eventType: PlanItemRow['eventType'];
  title: string;
  plannedTime: string;
  plannedDurationMin?: number | null | undefined;
  target?: Record<string, unknown> | null | undefined;
}

export class DailyPlansRepository {
  constructor(private readonly db: Db) {}

  async findByDate(userId: string, localDate: string): Promise<PlanWithItems | undefined> {
    const plan = await this.db.query.dailyPlans.findFirst({
      where: and(eq(dailyPlans.userId, userId), eq(dailyPlans.localDate, localDate)),
    });
    if (!plan) return undefined;
    return { plan, items: await this.itemsOf(plan.id) };
  }

  async findById(userId: string, id: string): Promise<PlanWithItems | undefined> {
    const plan = await this.db.query.dailyPlans.findFirst({
      where: and(eq(dailyPlans.id, id), eq(dailyPlans.userId, userId)),
    });
    if (!plan) return undefined;
    return { plan, items: await this.itemsOf(plan.id) };
  }

  private itemsOf(planId: string): Promise<PlanItemRow[]> {
    return this.db
      .select()
      .from(planItems)
      .where(eq(planItems.planId, planId))
      .orderBy(asc(planItems.sortOrder), asc(planItems.id));
  }

  async create(
    userId: string,
    localDate: string,
    items: PlanItemInput[],
    source: DailyPlanRow['source'] = 'user',
  ): Promise<PlanWithItems> {
    return this.db.transaction(async (tx) => {
      const [plan] = await tx
        .insert(dailyPlans)
        .values({ userId, localDate, source })
        .returning();
      if (!plan) throw new Error('plan insert returned no row');

      const inserted = await tx
        .insert(planItems)
        .values(
          items.map((item, index) => ({
            planId: plan.id,
            eventType: item.eventType,
            title: item.title,
            plannedTime: item.plannedTime,
            plannedDurationMin: item.plannedDurationMin ?? null,
            target: item.target ?? null,
            sortOrder: index,
          })),
        )
        .returning();

      return { plan, items: inserted };
    });
  }

  /**
   * Replaces the item list wholesale. This is the user editing their *intention*, which
   * is a different act from logging what happened — reconciliation never comes through
   * here (DATABASE_DESIGN.md §3.3).
   */
  async replaceItems(planId: string, items: PlanItemInput[]): Promise<PlanItemRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.delete(planItems).where(eq(planItems.planId, planId));
      if (items.length === 0) return [];

      return tx
        .insert(planItems)
        .values(
          items.map((item, index) => ({
            planId,
            eventType: item.eventType,
            title: item.title,
            plannedTime: item.plannedTime,
            plannedDurationMin: item.plannedDurationMin ?? null,
            target: item.target ?? null,
            sortOrder: index,
          })),
        )
        .returning();
    });
  }

  async updateStatus(
    userId: string,
    id: string,
    status: DailyPlanRow['status'],
  ): Promise<DailyPlanRow | undefined> {
    const [updated] = await this.db
      .update(dailyPlans)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(dailyPlans.id, id), eq(dailyPlans.userId, userId)))
      .returning();
    return updated;
  }

  async touch(planId: string): Promise<void> {
    await this.db
      .update(dailyPlans)
      .set({ updatedAt: new Date() })
      .where(eq(dailyPlans.id, planId));
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const [deleted] = await this.db
      .delete(dailyPlans)
      .where(and(eq(dailyPlans.id, id), eq(dailyPlans.userId, userId)))
      .returning({ id: dailyPlans.id });
    return deleted !== undefined;
  }

  /**
   * Writes the reconciliation outcome — and **only** the reconciliation columns.
   *
   * `planned_time`, `title`, `event_type` and `target` are untouched by design: the
   * plan records what the user intended, and the delta between that and what happened
   * is the product (ARCHITECTURE.md §6). This method is the reason that rule holds in
   * practice rather than only in the documentation.
   */
  async applyReconciliation(planId: string, results: readonly ReconciledItem[]): Promise<void> {
    if (results.length === 0) return;

    await this.db.transaction(async (tx) => {
      const now = new Date();

      // Released first, in the same transaction: the unique index on `linked_event_id`
      // would otherwise reject a re-run that moves an event from one item to another.
      await tx
        .update(planItems)
        .set({ linkedEventId: null })
        .where(
          and(
            eq(planItems.planId, planId),
            inArray(
              planItems.id,
              results.map((result) => result.planItemId),
            ),
          ),
        );

      for (const result of results) {
        await tx
          .update(planItems)
          .set({
            adherence: result.adherence,
            linkedEventId: result.linkedEventId,
            shiftMinutes: result.shiftMinutes,
            reconciledAt: now,
          })
          .where(and(eq(planItems.id, result.planItemId), eq(planItems.planId, planId)));
      }
    });
  }

  /** Adherence figures for a day, used by the summary recompute. */
  async adherenceFor(
    userId: string,
    localDate: string,
  ): Promise<{ resolved: number; happened: number } | undefined> {
    const rows = await this.db
      .select({
        resolved: sql<number>`count(*) filter (where ${planItems.adherence} <> 'pending')::int`,
        happened: sql<number>`count(*) filter (where ${planItems.linkedEventId} is not null)::int`,
      })
      .from(planItems)
      .innerJoin(dailyPlans, eq(planItems.planId, dailyPlans.id))
      .where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.localDate, localDate)));

    const row = rows[0];
    if (!row || row.resolved === 0) return undefined;
    return row;
  }
}
