import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { foodPortions, foods } from '../schema/index.js';
import { normalizeFoodName } from '../../nutrition/normalize.js';
import { VN_FOODS, validateDataset, type SeedFood } from './vn-foods/index.js';

/**
 * Loads the local Vietnamese dataset into `foods` and `food_portions`.
 *
 * Idempotent: keyed on `(provider, external_id)`, so re-running updates in place rather
 * than duplicating. That matters because the dataset is expected to be corrected over
 * time — a figure improves, and the next deploy should carry the improvement without
 * anyone writing a migration.
 *
 * It does **not** touch `provider='usda'` or `provider='off'` rows. Those are a cache of
 * external lookups; re-seeding local data must not evict them.
 */
export interface SeedResult {
  foodsUpserted: number;
  portionsUpserted: number;
}

export async function seedFoods(db: Db, dataset: readonly SeedFood[] = VN_FOODS): Promise<SeedResult> {
  const problems = validateDataset(dataset);
  if (problems.length > 0) {
    // Refuse to load a malformed dataset. A duplicate id or a missing default portion is
    // far cheaper to fix here than to diagnose from a user's meal total.
    throw new Error(`Food dataset is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  let foodsUpserted = 0;
  let portionsUpserted = 0;

  for (const food of dataset) {
    const [row] = await db
      .insert(foods)
      .values({
        canonicalName: food.nameVi,
        searchName: normalizeFoodName(food.nameVi),
        searchNameEn: normalizeFoodName(food.nameEn),
        nameVi: food.nameVi,
        nameEn: food.nameEn,
        provider: 'local',
        externalId: food.externalId,
        category: food.category,
        kcalPer100g: toNumeric(food.per100g.kcal),
        proteinPer100g: toNumeric(food.per100g.proteinG),
        carbsPer100g: toNumeric(food.per100g.carbsG),
        fatPer100g: toNumeric(food.per100g.fatG),
        fiberPer100g: toNumeric(food.per100g.fiberG),
        dataQuality: food.dataQuality,
        sourceReference: food.sourceReference,
        searchPriority: food.searchPriority ?? 0,
      })
      .onConflictDoUpdate({
        target: [foods.provider, foods.externalId],
        set: {
          canonicalName: food.nameVi,
          searchName: normalizeFoodName(food.nameVi),
          searchNameEn: normalizeFoodName(food.nameEn),
          nameVi: food.nameVi,
          nameEn: food.nameEn,
          category: food.category,
          kcalPer100g: toNumeric(food.per100g.kcal),
          proteinPer100g: toNumeric(food.per100g.proteinG),
          carbsPer100g: toNumeric(food.per100g.carbsG),
          fatPer100g: toNumeric(food.per100g.fatG),
          fiberPer100g: toNumeric(food.per100g.fiberG),
          dataQuality: food.dataQuality,
          sourceReference: food.sourceReference,
          searchPriority: food.searchPriority ?? 0,
          cachedAt: sql`now()`,
        },
      })
      .returning({ id: foods.id });

    if (!row) throw new Error(`food upsert returned no row for ${food.externalId}`);
    foodsUpserted += 1;

    // Portions are replaced wholesale: the set of measures for a food is authored as a
    // unit, and a removed portion should disappear rather than linger.
    await db.delete(foodPortions).where(eq(foodPortions.foodId, row.id));
    if (food.portions.length > 0) {
      await db.insert(foodPortions).values(
        food.portions.map((portion) => ({
          foodId: row.id,
          label: portion.label,
          labelVi: portion.labelVi ?? null,
          grams: portion.grams.toFixed(2),
          isDefault: portion.isDefault ?? false,
        })),
      );
      portionsUpserted += food.portions.length;
    }
  }

  return { foodsUpserted, portionsUpserted };
}

/** Postgres `numeric` round-trips as a string, which is what preserves the precision. */
function toNumeric(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}
