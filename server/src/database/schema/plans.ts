import { relations, sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiRuns } from './ai.js';
import { adherenceEnum, eventTypeEnum, planSourceEnum, planStatusEnum } from './enums.js';
import { dailyEvents } from './events.js';
import { users } from './users.js';

/** A plan is an intention. One per user per local day. */
export const dailyPlans = pgTable(
  'daily_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localDate: date('local_date').notNull(),
    source: planSourceEnum('source').notNull().default('user'),
    status: planStatusEnum('status').notNull().default('active'),
    /**
     * Phase 4 landed `ai_runs`, so the constraint this column was waiting for exists
     * now — one constraint, no data migration, exactly as DATABASE_DESIGN.md §3.9 said.
     *
     * `set null` rather than `cascade`: pruning the operational ledger must never take
     * a user's plan with it. Losing the provenance of a plan is a gap; losing the plan
     * is data loss.
     */
    generatedByAiRun: uuid('generated_by_ai_run').references(() => aiRuns.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_plans_user_date').on(table.userId, table.localDate)],
);

/**
 * `plan_items` are **never mutated by logging** (ARCHITECTURE.md §6). Reconciliation
 * writes `linked_event_id`, `adherence`, `shift_minutes` and `reconciled_at`, leaving
 * `planned_time` and `title` exactly as the user intended them. Overwriting a plan
 * with what actually happened would destroy the only signal the product has.
 *
 * There is no `user_id` here — ownership runs through `plan_id`, and both the
 * repository layer and the RLS policy scope through the parent plan.
 */
export const planItems = pgTable(
  'plan_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => dailyPlans.id, { onDelete: 'cascade' }),
    eventType: eventTypeEnum('event_type').notNull(),
    title: text('title').notNull(),
    plannedTime: time('planned_time').notNull(),
    plannedDurationMin: integer('planned_duration_min'),
    target: jsonb('target').$type<Record<string, unknown>>(),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Set on reconciliation, cleared if the event is deleted. `ON DELETE SET NULL`
     * rather than cascade: deleting a logged event must not delete the intention.
     */
    linkedEventId: uuid('linked_event_id').references(() => dailyEvents.id, {
      onDelete: 'set null',
    }),
    adherence: adherenceEnum('adherence').notNull().default('pending'),
    shiftMinutes: integer('shift_minutes'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_plan_items_plan').on(table.planId, table.sortOrder),
    // One event satisfies at most one plan item.
    uniqueIndex('idx_plan_items_link')
      .on(table.linkedEventId)
      .where(sql`${table.linkedEventId} is not null`),
  ],
);

export const dailyPlansRelations = relations(dailyPlans, ({ one, many }) => ({
  user: one(users, { fields: [dailyPlans.userId], references: [users.id] }),
  items: many(planItems),
}));

export const planItemsRelations = relations(planItems, ({ one }) => ({
  plan: one(dailyPlans, { fields: [planItems.planId], references: [dailyPlans.id] }),
  linkedEvent: one(dailyEvents, {
    fields: [planItems.linkedEventId],
    references: [dailyEvents.id],
  }),
}));
