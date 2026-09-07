import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  mealItemUnitEnum,
  mealStatusEnum,
  mealTypeEnum,
  nutritionSourceEnum,
  portionLabelEnum,
} from './enums.js';
import { dailyEvents } from './events.js';
import { foods } from './foods.js';
import { users } from './users.js';

/**
 * Draft-first (DATABASE_DESIGN.md §3.4). A meal exists as `status='draft'` from the
 * moment vision or parsing produces it, *before* the user confirms — which is what
 * makes "the user outranks the AI" possible: they are correcting a stored draft, not
 * racing an ephemeral response.
 *
 * `event_id` is null while draft and set on confirm. A draft is not yet something that
 * happened, so it must not reach the timeline or the Pattern Engine.
 *
 * Created in Phase 2; written by Phase 3 (nutrition) and Phase 4 (vision).
 */
export const meals = pgTable(
  'meals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .unique()
      .references(() => dailyEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mealType: mealTypeEnum('meal_type').notNull(),
    status: mealStatusEnum('status').notNull().default('draft'),
    rawInput: text('raw_input'),
    /** A Supabase Storage key. Postgres is not a blob store (ARCHITECTURE.md §22). */
    imageKey: text('image_key'),
    totalKcal: numeric('total_kcal', { precision: 8, scale: 2 }),
    totalProteinG: numeric('total_protein_g', { precision: 8, scale: 2 }),
    totalCarbsG: numeric('total_carbs_g', { precision: 8, scale: 2 }),
    totalFatG: numeric('total_fat_g', { precision: 8, scale: 2 }),
    totalFiberG: numeric('total_fiber_g', { precision: 8, scale: 2 }),
    nutritionSource: nutritionSourceEnum('nutrition_source'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    userConfirmed: boolean('user_confirmed').notNull().default(false),
    userEdited: boolean('user_edited').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_meals_user_created')
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
    index('idx_meals_draft')
      .on(table.userId, table.status)
      .where(sql`${table.status} = 'draft'`),
    // A confirmed meal is attached to an event; a draft is not.
    check(
      'chk_meal_event',
      sql`(${table.status} = 'confirmed') = (${table.eventId} is not null)`,
    ),
    check(
      'chk_meal_confidence',
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
  ],
);

/**
 * Nutrition values are **denormalised on purpose** (DATABASE_DESIGN.md §5). If USDA
 * revises a figure, historical meals keep the numbers the user actually saw and
 * confirmed. Nutrition history is an audit record, not a live join — which is also why
 * `food_id` is `ON DELETE SET NULL`: evicting a cached food must never destroy a meal.
 */
export const mealItems = pgTable(
  'meal_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mealId: uuid('meal_id')
      .notNull()
      .references(() => meals.id, { onDelete: 'cascade' }),
    foodId: uuid('food_id').references(() => foods.id, { onDelete: 'set null' }),
    detectedName: text('detected_name').notNull(),
    displayNameVi: text('display_name_vi'),
    displayNameEn: text('display_name_en'),
    quantity: numeric('quantity', { precision: 8, scale: 3 }).notNull(),
    unit: mealItemUnitEnum('unit').notNull(),
    gramsResolved: numeric('grams_resolved', { precision: 8, scale: 2 }),
    portionLabel: portionLabelEnum('portion_label'),
    /** Null means unresolved — never a fabricated number (Rule 6). */
    kcal: numeric('kcal', { precision: 8, scale: 2 }),
    proteinG: numeric('protein_g', { precision: 8, scale: 2 }),
    carbsG: numeric('carbs_g', { precision: 8, scale: 2 }),
    fatG: numeric('fat_g', { precision: 8, scale: 2 }),
    fiberG: numeric('fiber_g', { precision: 8, scale: 2 }),
    source: nutritionSourceEnum('source').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    userConfirmed: boolean('user_confirmed').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    index('idx_meal_items_meal').on(table.mealId, table.sortOrder),
    check('chk_confidence', sql`${table.confidence} >= 0 and ${table.confidence} <= 1`),
    check('chk_quantity', sql`${table.quantity} > 0`),
    check('chk_nonneg_kcal', sql`${table.kcal} is null or ${table.kcal} >= 0`),
  ],
);

export const mealsRelations = relations(meals, ({ one, many }) => ({
  user: one(users, { fields: [meals.userId], references: [users.id] }),
  event: one(dailyEvents, { fields: [meals.eventId], references: [dailyEvents.id] }),
  items: many(mealItems),
}));

export const mealItemsRelations = relations(mealItems, ({ one }) => ({
  meal: one(meals, { fields: [mealItems.mealId], references: [meals.id] }),
  food: one(foods, { fields: [mealItems.foodId], references: [foods.id] }),
}));
