import { relations, sql } from 'drizzle-orm';
import {
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { moodEnum } from './enums.js';
import { users } from './users.js';

/**
 * A materialised view of one local day, recomputed on write (DATABASE_DESIGN.md §1.4).
 * Opening the Home tab costs one indexed read and **zero** AI calls — which is what
 * makes the cost model in ARCHITECTURE.md §7 hold.
 *
 * It is derived, never authoritative. Every figure here can be recomputed from
 * `daily_events`, `plan_items` and `checkins`; if the two ever disagree, the source
 * tables are right and this row is stale.
 *
 * Phase 2 computes the behavioural fields. The nutrition fields (`total_kcal`,
 * `vegetable_servings`, `protein_servings`, `distinct_foods`) stay at their zero /
 * null defaults until Phase 3 gives them a real source — a fabricated calorie total
 * would be exactly the anti-pattern NUTRITION_ARCHITECTURE.md §1 exists to prevent.
 */
export const dailySummaries = pgTable(
  'daily_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localDate: date('local_date').notNull(),

    eventsLogged: integer('events_logged').notNull().default(0),
    mealsLogged: integer('meals_logged').notNull().default(0),
    vegetableServings: integer('vegetable_servings').notNull().default(0),
    proteinServings: integer('protein_servings').notNull().default(0),
    distinctFoods: integer('distinct_foods').notNull().default(0),
    waterMl: numeric('water_ml', { precision: 8, scale: 1 }).notNull().default('0'),
    sleepMinutes: integer('sleep_minutes'),
    firstMealTime: time('first_meal_time'),
    lastMealTime: time('last_meal_time'),
    bedtime: time('bedtime'),
    planAdherencePct: numeric('plan_adherence_pct', { precision: 5, scale: 2 }),
    totalKcal: numeric('total_kcal', { precision: 8, scale: 2 }),
    mood: moodEnum('mood'),
    /** Extensible bag, so a new derived metric costs no migration. */
    metrics: jsonb('metrics').$type<Record<string, number | string | null>>(),
    /** Filled by Claude in Phase 5. A summary is valid and useful without prose. */
    narrative: text('narrative'),
    aiRunId: uuid('ai_run_id'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_daily_sum').on(table.userId, table.localDate),
    check(
      'chk_summary_adherence',
      sql`${table.planAdherencePct} is null or (${table.planAdherencePct} between 0 and 100)`,
    ),
    check('chk_summary_counts', sql`${table.eventsLogged} >= 0 and ${table.mealsLogged} >= 0`),
  ],
);

export const dailySummariesRelations = relations(dailySummaries, ({ one }) => ({
  user: one(users, { fields: [dailySummaries.userId], references: [users.id] }),
}));
