import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { dataQualityEnum, foodProviderEnum } from './enums.js';

/** PostgreSQL full-text search vector — Drizzle has no built-in for it. */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

/**
 * One table serves all three nutrition providers, discriminated by
 * `provider` + `external_id` (DATABASE_DESIGN.md §3.6). USDA and Open Food Facts rows
 * are cached on first use; `provider='local'` rows are AURA's own Vietnamese dataset,
 * authored rather than fetched, and never expired.
 *
 * Created in Phase 2 as part of the coherent schema; populated and queried in Phase 3.
 * This is public reference data — the only table in the design that is not user-owned,
 * and the only one whose RLS policy is world-readable.
 */
export const foods = pgTable(
  'foods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalName: text('canonical_name').notNull(),
    /**
     * The diacritic-free, lowercased form every lookup keys on. Computed in the
     * application (`nutrition/normalize.ts`) rather than by `unaccent()`, which is only
     * STABLE and so cannot back an index expression honestly.
     */
    searchName: text('search_name').notNull(),
    /** The same, for the English name — so "white rice" finds cơm trắng too. */
    searchNameEn: text('search_name_en').notNull().default(''),
    nameVi: text('name_vi'),
    nameEn: text('name_en').notNull(),
    provider: foodProviderEnum('provider').notNull(),
    externalId: text('external_id').notNull(),
    barcode: text('barcode'),
    category: text('category'),
    kcalPer100g: numeric('kcal_per_100g', { precision: 8, scale: 2 }),
    proteinPer100g: numeric('protein_per_100g', { precision: 8, scale: 2 }),
    carbsPer100g: numeric('carbs_per_100g', { precision: 8, scale: 2 }),
    fatPer100g: numeric('fat_per_100g', { precision: 8, scale: 2 }),
    fiberPer100g: numeric('fiber_per_100g', { precision: 8, scale: 2 }),
    micronutrients: jsonb('micronutrients').$type<Record<string, number>>(),
    dataQuality: dataQualityEnum('data_quality').notNull().default('medium'),
    /**
     * How this row's figures were arrived at — a USDA reference item, a component-derived
     * recipe estimate, or an external provider payload. Provenance travels with the row
     * rather than living in a spreadsheet, because the first question about any nutrition
     * number is where it came from.
     */
    sourceReference: text('source_reference'),
    /**
     * Tiebreak for ambiguous short queries. A bare "cơm" is a real query and both
     * *cơm trắng* and *cơm gà* match it equally well on trigrams; without a curated
     * preference the shorter name wins, which is how "rice" ends up meaning chicken
     * rice. Higher wins. 0 for everything that is not a common default.
     */
    searchPriority: integer('search_priority').notNull().default(0),
    searchVector: tsvector('search_vector'),
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_foods_provider_ext').on(table.provider, table.externalId),
    index('idx_foods_barcode').on(table.barcode).where(sql`${table.barcode} is not null`),
    index('idx_foods_search').using('gin', table.searchVector),
    // pg_trgm — what makes "thit kho" find "thịt kho" without diacritics (migration 0000).
    // pg_trgm over the normalised column — what makes "thit kho" find "thịt kho".
    index('idx_foods_search_trgm').using('gin', sql`${table.searchName} gin_trgm_ops`),
    index('idx_foods_search_en_trgm').using('gin', sql`${table.searchNameEn} gin_trgm_ops`),
    check('chk_food_kcal_nonneg', sql`${table.kcalPer100g} is null or ${table.kcalPer100g} >= 0`),
  ],
);

/** "2 chén cơm" is only resolvable because `label_vi='1 chén'` maps to grams. */
export const foodPortions = pgTable(
  'food_portions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    labelVi: text('label_vi'),
    grams: numeric('grams', { precision: 8, scale: 2 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (table) => [
    index('idx_food_portions_food').on(table.foodId),
    check('chk_portion_grams', sql`${table.grams} > 0`),
  ],
);

export const foodsRelations = relations(foods, ({ many }) => ({
  portions: many(foodPortions),
}));

export const foodPortionsRelations = relations(foodPortions, ({ one }) => ({
  food: one(foods, { fields: [foodPortions.foodId], references: [foods.id] }),
}));
