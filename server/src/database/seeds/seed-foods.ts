import { inArray, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { foodPortions, foods } from '../schema/index.js';
import { normalizeFoodName } from '../../nutrition/normalize.js';
import { VN_FOODS, portionKey, validateDataset, type SeedFood } from './vn-foods/index.js';

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
 *
 * ## Portion identity
 *
 * A portion is identified by its food and its normalised English `label` (`portionKey`) —
 * the dataset validator guarantees that pair is unique per food. Re-seeding reconciles
 * against it: a portion that is still in the dataset keeps its `id` and is updated in place
 * (only when something actually changed), a new one is inserted, and one that has left the
 * dataset is **kept** — `meal_items.portion_id` may point at it, and the FK is
 * `ON DELETE SET NULL`, so deleting it would silently erase which portion a confirmed meal
 * was measured in. A retired portion only loses `is_default`, so the dataset's own default
 * stays the one a bare "1 serving" resolves to. Renaming a label is therefore a new portion,
 * not an edit; correcting a gram value is an edit.
 *
 * The whole run is one transaction under an advisory lock: a failure leaves the tables as
 * they were, and two concurrent runs (two deploys racing) cannot both insert the same new
 * portion. Two rows already sharing a key for one food are refused, not merged — the seed
 * cannot know which one historical meals meant.
 */
export interface SeedResult {
  foodsUpserted: number;
  /** Dataset portions now present: inserted + updated + unchanged. */
  portionsUpserted: number;
  portionsInserted: number;
  portionsUpdated: number;
  portionsUnchanged: number;
  /** In the database for a seeded food but no longer in the dataset: kept, never deleted. */
  portionsRetained: number;
}

/** Serialises seed runs; scoped to the transaction, so it is released on commit or rollback. */
const SEED_LOCK_KEY = 'seed:foods';

export async function seedFoods(db: Db, dataset: readonly SeedFood[] = VN_FOODS): Promise<SeedResult> {
  const problems = validateDataset(dataset);
  if (problems.length > 0) {
    // Refuse to load a malformed dataset. A duplicate id or a missing default portion is
    // far cheaper to fix here than to diagnose from a user's meal total.
    throw new Error(`Food dataset is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${SEED_LOCK_KEY}, 0))`);

    const result: SeedResult = {
      foodsUpserted: 0,
      portionsUpserted: 0,
      portionsInserted: 0,
      portionsUpdated: 0,
      portionsUnchanged: 0,
      portionsRetained: 0,
    };

    const foodIds = new Map<string, string>();
    for (const food of dataset) {
      const [row] = await tx
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
      foodIds.set(food.externalId, row.id);
      result.foodsUpserted += 1;
    }

    // Every existing portion of every seeded food, in one read.
    const existingRows = foodIds.size === 0
      ? []
      : await tx
          .select({
            id: foodPortions.id,
            foodId: foodPortions.foodId,
            label: foodPortions.label,
            labelVi: foodPortions.labelVi,
            grams: foodPortions.grams,
            isDefault: foodPortions.isDefault,
          })
          .from(foodPortions)
          .where(inArray(foodPortions.foodId, [...foodIds.values()]));
    const existingByFood = new Map<string, typeof existingRows>();
    for (const row of existingRows) {
      const list = existingByFood.get(row.foodId) ?? [];
      list.push(row);
      existingByFood.set(row.foodId, list);
    }

    const inserts: Array<typeof foodPortions.$inferInsert> = [];
    for (const food of dataset) {
      const foodId = foodIds.get(food.externalId)!;

      const existing = new Map<string, (typeof existingRows)[number]>();
      for (const row of existingByFood.get(foodId) ?? []) {
        const key = portionKey(row.label);
        if (existing.has(key)) {
          throw new Error(
            `food_portions holds more than one "${row.label}" portion for ${food.externalId}; ` +
              'refusing to choose between them — resolve the duplicate before seeding',
          );
        }
        existing.set(key, row);
      }

      const wanted = new Set<string>();
      for (const portion of food.portions) {
        const key = portionKey(portion.label);
        wanted.add(key);
        const values = {
          label: portion.label,
          labelVi: portion.labelVi ?? null,
          grams: portion.grams.toFixed(2),
          isDefault: portion.isDefault ?? false,
        };
        const row = existing.get(key);
        if (!row) {
          inserts.push({ foodId, ...values });
        } else if (
          row.label !== values.label ||
          row.labelVi !== values.labelVi ||
          row.grams !== values.grams ||
          row.isDefault !== values.isDefault
        ) {
          await tx.update(foodPortions).set(values).where(eq(foodPortions.id, row.id));
          result.portionsUpdated += 1;
        } else {
          result.portionsUnchanged += 1;
        }
      }

      // Left the dataset: keep the row, so a meal measured in it keeps saying so.
      for (const [key, row] of existing) {
        if (wanted.has(key)) continue;
        result.portionsRetained += 1;
        if (row.isDefault) {
          await tx.update(foodPortions).set({ isDefault: false }).where(eq(foodPortions.id, row.id));
        }
      }
    }

    if (inserts.length > 0) await tx.insert(foodPortions).values(inserts);
    result.portionsInserted = inserts.length;
    result.portionsUpserted = result.portionsInserted + result.portionsUpdated + result.portionsUnchanged;
    return result;
  });
}

/** Postgres `numeric` round-trips as a string, which is what preserves the precision. */
function toNumeric(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}
