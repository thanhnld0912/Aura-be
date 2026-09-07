import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../database/client.js';
import { foodPortions, foods, userFoodAliases } from '../database/schema/index.js';
import { normalizeFoodName } from './normalize.js';
import type { DataQuality, FoodCandidate, NutrientsPer100g, PortionDefinition } from './types.js';

/**
 * Data access for the nutrition domain.
 *
 * `nutrition/` is a library — it has no HTTP or auth awareness (ARCHITECTURE.md §5) — but
 * it does own the food tables, because `LocalFoodProvider` is a database query and
 * pretending otherwise would put the whole resolver behind a service call.
 *
 * The one method that takes a `userId` is the alias lookup, and it scopes on it.
 */

export type FoodRow = typeof foods.$inferSelect;

/**
 * pg_trgm similarity floor for a fuzzy hit (NUTRITION_ARCHITECTURE.md §4 step 3).
 * Below this the match is noise, and `unresolved` is a better answer than a wrong food.
 */
export const FUZZY_SIMILARITY_THRESHOLD = 0.45;

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function per100gOf(row: FoodRow): NutrientsPer100g {
  return {
    kcal: toNumber(row.kcalPer100g),
    proteinG: toNumber(row.proteinPer100g),
    carbsG: toNumber(row.carbsPer100g),
    fatG: toNumber(row.fatPer100g),
    fiberG: toNumber(row.fiberPer100g),
  };
}

export function toCandidate(
  row: FoodRow,
  matchConfidence: number,
  matchedBy: FoodCandidate['matchedBy'],
): FoodCandidate {
  return {
    foodId: row.id,
    canonicalName: row.canonicalName,
    nameVi: row.nameVi,
    nameEn: row.nameEn,
    category: row.category,
    provider: row.provider,
    dataQuality: row.dataQuality as DataQuality,
    per100g: per100gOf(row),
    matchConfidence,
    matchedBy,
  };
}

export interface AliasHit {
  foodId: string;
  defaultGrams: number | null;
}

export class FoodRepository {
  constructor(private readonly db: Db) {}

  /** Exact hit on the normalised name — the fast path for a food we already know. */
  async findExact(query: string, provider?: 'local' | 'usda' | 'off'): Promise<FoodRow | undefined> {
    const normalized = normalizeFoodName(query);
    if (normalized.length === 0) return undefined;

    const conditions = [eq(foods.searchName, normalized)];
    if (provider) conditions.push(eq(foods.provider, provider));

    return this.db.query.foods.findFirst({ where: and(...conditions) });
  }

  /**
   * Fuzzy search over the diacritic-stripped columns.
   *
   * **Filtering uses `word_similarity`, ranking uses `similarity`**, and the distinction
   * is the whole reason this works. Plain `similarity()` compares two strings as wholes,
   * so a short query scores terribly against a long name — `similarity('com', 'com trang')`
   * is far below any usable threshold, and "cơm" would find no rice at all. Postgres's
   * `word_similarity(query, target)` instead asks how well the query matches the *best
   * run of words* inside the target, which is exactly the question being asked.
   *
   * Ranking then falls back to whole-string similarity so that, among the many foods
   * containing "cơm", plain `cơm trắng` outranks `cơm tấm sườn bì chả`. Provider order
   * breaks remaining ties, because the local dataset is the primary source (§2).
   *
   * Both columns are searched, so "white rice" finds cơm trắng as readily as "cơm" does.
   */
  async searchFuzzy(
    query: string,
    options: { limit?: number; provider?: 'local' | 'usda' | 'off'; threshold?: number } = {},
  ): Promise<Array<{ row: FoodRow; similarity: number }>> {
    const normalized = normalizeFoodName(query);
    if (normalized.length === 0) return [];

    const threshold = options.threshold ?? FUZZY_SIMILARITY_THRESHOLD;

    const wordMatch = sql<number>`greatest(
      word_similarity(${normalized}, ${foods.searchName}),
      word_similarity(${normalized}, ${foods.searchNameEn})
    )`;
    const wholeMatch = sql<number>`greatest(
      similarity(${foods.searchName}, ${normalized}),
      similarity(${foods.searchNameEn}, ${normalized})
    )`;

    const conditions = [gt(wordMatch, threshold)];
    if (options.provider) conditions.push(eq(foods.provider, options.provider));

    const rows = await this.db
      .select({ row: foods, score: wholeMatch, wordScore: wordMatch })
      .from(foods)
      .where(and(...conditions))
      .orderBy(
        /**
         * The curated default wins **only when the query matches as complete words**.
         *
         * `word_similarity = 1` means the whole query appears as a run of words in the
         * name, which is precisely the ambiguous case: "cơm" is fully contained in both
         * *cơm trắng* and *cơm gà*, and whole-string similarity then prefers the shorter
         * name, so "rice" would mean chicken rice. Where the query is only a partial
         * match this contributes nothing and the score decides on its own merit.
         */
        desc(sql`case when ${wordMatch} >= 0.999 then ${foods.searchPriority} else 0 end`),
        desc(wholeMatch),
        desc(wordMatch),
        // Alphabetical provider order is not the priority order, so be explicit.
        sql`case ${foods.provider} when 'local' then 1 when 'usda' then 2 else 3 end`,
      )
      .limit(options.limit ?? 10);

    return rows.map((entry) => ({
      row: entry.row,
      // The reported score is the stronger of the two readings: a query that matches a
      // name outright and one that matches it as a phrase are both good matches.
      similarity: Math.max(Number(entry.score), Number(entry.wordScore)),
    }));
  }

  async findById(foodId: string): Promise<FoodRow | undefined> {
    return this.db.query.foods.findFirst({ where: eq(foods.id, foodId) });
  }

  async findByBarcode(barcode: string): Promise<FoodRow | undefined> {
    return this.db.query.foods.findFirst({ where: eq(foods.barcode, barcode) });
  }

  async findByExternalId(
    provider: 'local' | 'usda' | 'off',
    externalId: string,
  ): Promise<FoodRow | undefined> {
    return this.db.query.foods.findFirst({
      where: and(eq(foods.provider, provider), eq(foods.externalId, externalId)),
    });
  }

  async portionsOf(foodId: string): Promise<PortionDefinition[]> {
    const rows = await this.db
      .select()
      .from(foodPortions)
      .where(eq(foodPortions.foodId, foodId))
      .orderBy(desc(foodPortions.isDefault), asc(foodPortions.grams));

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      labelVi: row.labelVi ?? undefined,
      grams: Number(row.grams),
      isDefault: row.isDefault,
    }));
  }

  /**
   * Step 1 of the resolution chain: has this user already corrected this exact phrase?
   * Scoped to the user, because an alias is a personal correction, not a global fact.
   */
  async findAlias(userId: string, phrase: string): Promise<AliasHit | undefined> {
    const normalized = normalizeFoodName(phrase);
    if (normalized.length === 0) return undefined;

    const row = await this.db.query.userFoodAliases.findFirst({
      where: and(
        eq(userFoodAliases.userId, userId),
        eq(userFoodAliases.aliasNormalized, normalized),
      ),
    });

    return row ? { foodId: row.foodId, defaultGrams: toNumber(row.defaultGrams) } : undefined;
  }

  /**
   * Records a correction, or bumps the count if the user has made it before.
   *
   * This is the loop that makes AURA improve with use: ambiguity surfaced, user corrects,
   * next time it resolves at full confidence — personalisation without fine-tuning
   * anything (§4).
   */
  async rememberAlias(
    userId: string,
    phrase: string,
    foodId: string,
    defaultGrams?: number | null,
  ): Promise<void> {
    const normalized = normalizeFoodName(phrase);
    if (normalized.length === 0) return;

    await this.db
      .insert(userFoodAliases)
      .values({
        userId,
        alias: phrase,
        aliasNormalized: normalized,
        foodId,
        defaultGrams: defaultGrams == null ? null : defaultGrams.toFixed(2),
      })
      .onConflictDoUpdate({
        target: [userFoodAliases.userId, userFoodAliases.aliasNormalized],
        set: {
          foodId,
          ...(defaultGrams == null ? {} : { defaultGrams: defaultGrams.toFixed(2) }),
          useCount: sql`${userFoodAliases.useCount} + 1`,
          lastUsedAt: sql`now()`,
        },
      });
  }

  /** Caches an external provider's food so the next lookup costs nothing (§7). */
  async cacheExternalFood(record: {
    provider: 'usda' | 'off';
    externalId: string;
    canonicalName: string;
    nameEn: string;
    nameVi?: string | null;
    category?: string | null;
    barcode?: string | null;
    per100g: NutrientsPer100g;
    dataQuality: DataQuality;
    sourceReference: string;
  }): Promise<FoodRow> {
    const [row] = await this.db
      .insert(foods)
      .values({
        canonicalName: record.canonicalName,
        searchName: normalizeFoodName(record.canonicalName),
        searchNameEn: normalizeFoodName(record.nameEn),
        nameVi: record.nameVi ?? null,
        nameEn: record.nameEn,
        provider: record.provider,
        externalId: record.externalId,
        barcode: record.barcode ?? null,
        category: record.category ?? null,
        kcalPer100g: numeric(record.per100g.kcal),
        proteinPer100g: numeric(record.per100g.proteinG),
        carbsPer100g: numeric(record.per100g.carbsG),
        fatPer100g: numeric(record.per100g.fatG),
        fiberPer100g: numeric(record.per100g.fiberG),
        dataQuality: record.dataQuality,
        sourceReference: record.sourceReference,
      })
      .onConflictDoUpdate({
        target: [foods.provider, foods.externalId],
        set: { cachedAt: sql`now()` },
      })
      .returning();

    if (!row) throw new Error('food cache upsert returned no row');
    return row;
  }
}

function numeric(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}
