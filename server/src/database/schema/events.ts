import { relations, sql } from 'drizzle-orm';
import { date, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { eventSourceEnum, eventTypeEnum, inputMethodEnum } from './enums.js';
import { users } from './users.js';

/**
 * `daily_events` is the spine (ARCHITECTURE.md §6). One row per thing that actually
 * happened, with a typed detail row hanging off it. A new event type costs one enum
 * value and one detail table, never a rewrite.
 *
 * It is *observation*. `plan_items` is *intention*. They are never the same row, and
 * logging never mutates a plan — the difference between the two is the entire product.
 *
 * `local_date` is stored alongside `occurred_at` because "did they eat breakfast on
 * Tuesday" is a local-calendar question, not a UTC one (DATABASE_DESIGN.md §1.6). It
 * is derived from `occurred_at` in the user's timezone at write time.
 */
export const dailyEvents = pgTable(
  'daily_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localDate: date('local_date').notNull(),
    type: eventTypeEnum('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    durationMin: integer('duration_min'),
    title: text('title').notNull(),
    note: text('note'),
    inputMethod: inputMethodEnum('input_method').notNull().default('manual'),
    source: eventSourceEnum('source').notNull().default('user'),
    /**
     * `walk` and `water` deliberately have no detail table at MVP — volume and the
     * like live here (DATABASE_DESIGN.md §3.2). Not in the Phase 0 ERD column list,
     * but named in §3.2 and accepted by `POST /api/events`.
     */
    metrics: jsonb('metrics').$type<Record<string, number>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete — the Pattern Engine depends on history an accidental swipe must not destroy. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // Hot path: today's timeline (DATABASE_DESIGN.md §4).
    index('idx_events_user_date')
      .on(table.userId, table.localDate.desc())
      .where(sql`${table.deletedAt} is null`),
    index('idx_events_user_type_date')
      .on(table.userId, table.type, table.localDate.desc())
      .where(sql`${table.deletedAt} is null`),
    index('idx_events_occurred').on(table.userId, table.occurredAt.desc()),
  ],
);

export const dailyEventsRelations = relations(dailyEvents, ({ one }) => ({
  user: one(users, { fields: [dailyEvents.userId], references: [users.id] }),
}));
