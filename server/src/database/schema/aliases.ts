import { relations, sql } from 'drizzle-orm';
import {
  check,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { foods } from './foods.js';
import { users } from './users.js';

/**
 * What makes AURA improve with use (NUTRITION_ARCHITECTURE.md §4 step 1).
 *
 * When a user corrects "cơm mẹ nấu" to *cơm trắng*, the phrase is written here, and every
 * future log of it resolves instantly at full confidence. Personalisation without
 * fine-tuning anything, and without an LLM in the read path.
 *
 * `alias_normalized` is what the lookup keys on — diacritic-free and lowercased, so the
 * user does not have to reproduce their own typing exactly.
 */
export const userFoodAliases = pgTable(
  'user_food_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** As the user typed it, for display. */
    alias: text('alias').notNull(),
    /** As it is matched — see `nutrition/normalize.ts`. */
    aliasNormalized: text('alias_normalized').notNull(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'cascade' }),
    /** Remembers the portion too, when the correction included one. */
    defaultGrams: numeric('default_grams', { precision: 8, scale: 2 }),
    useCount: integer('use_count').notNull().default(1),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_alias_user_phrase').on(table.userId, table.aliasNormalized),
    check(
      'chk_alias_grams',
      sql`${table.defaultGrams} is null or ${table.defaultGrams} > 0`,
    ),
  ],
);

export const userFoodAliasesRelations = relations(userFoodAliases, ({ one }) => ({
  user: one(users, { fields: [userFoodAliases.userId], references: [users.id] }),
  food: one(foods, { fields: [userFoodAliases.foodId], references: [foods.id] }),
}));
