import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { dailyEvents, mealItems, meals } from '../../database/schema/index.js';
import type { ResolvedItem } from '../../nutrition/food-resolver.js';

/**
 * The only layer that touches `meals` and `meal_items` (ARCHITECTURE.md §5).
 *
 * Every lookup takes the owner as well as the id, so another user's meal is `undefined`
 * and the service turns that into a 404 — indistinguishable from a meal that does not
 * exist (SECURITY.md §2).
 */

export type MealRow = typeof meals.$inferSelect;
export type MealItemRow = typeof mealItems.$inferSelect;

export interface MealWithItems {
  meal: MealRow;
  items: MealItemRow[];
}

export interface CreateMealInput {
  userId: string;
  mealType: MealRow['mealType'];
  status: 'draft' | 'confirmed';
  rawInput?: string | null;
  /** Present only for a confirmed meal — the schema check enforces the pairing. */
  eventId?: string | null;
  totals: {
    kcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    fiberG: number | null;
  };
  confidence: number | null;
  nutritionSource: MealRow['nutritionSource'];
  items: readonly ResolvedItem[];
}

function numeric(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

export class MealsRepository {
  constructor(private readonly db: Db) {}

  /**
   * A meal and its items are written together or not at all. A meal with no items is not
   * a meal, and a half-written one would show the user a total that does not add up.
   */
  async create(input: CreateMealInput): Promise<MealWithItems> {
    return this.db.transaction(async (tx) => {
      const [meal] = await tx
        .insert(meals)
        .values({
          userId: input.userId,
          mealType: input.mealType,
          status: input.status,
          rawInput: input.rawInput ?? null,
          eventId: input.eventId ?? null,
          totalKcal: numeric(input.totals.kcal),
          totalProteinG: numeric(input.totals.proteinG),
          totalCarbsG: numeric(input.totals.carbsG),
          totalFatG: numeric(input.totals.fatG),
          totalFiberG: numeric(input.totals.fiberG),
          nutritionSource: input.nutritionSource,
          confidence: input.confidence === null ? null : input.confidence.toFixed(3),
        })
        .returning();

      if (!meal) throw new Error('meal insert returned no row');

      const items = await this.insertItems(tx, meal.id, input.items);
      return { meal, items };
    });
  }

  private async insertItems(
    tx: Db,
    mealId: string,
    resolved: readonly ResolvedItem[],
  ): Promise<MealItemRow[]> {
    if (resolved.length === 0) return [];

    return tx
      .insert(mealItems)
      .values(
        resolved.map((item, index) => ({
          mealId,
          foodId: item.foodId,
          portionId: item.portionId,
          detectedName: item.detectedName,
          displayNameVi: item.displayNameVi,
          displayNameEn: item.displayNameEn,
          quantity: item.quantity.toFixed(3),
          unit: item.unit,
          gramsResolved: numeric(item.gramsResolved),
          portionLabel: item.portionLabel,
          // The nutrition snapshot. Denormalised on purpose (DATABASE_DESIGN.md §5): if a
          // provider revises a figure, this meal keeps the numbers the user confirmed.
          kcal: numeric(item.nutrients.kcal),
          proteinG: numeric(item.nutrients.proteinG),
          carbsG: numeric(item.nutrients.carbsG),
          fatG: numeric(item.nutrients.fatG),
          fiberG: numeric(item.nutrients.fiberG),
          source: item.source,
          confidence: item.confidence.toFixed(3),
          sortOrder: index,
        })),
      )
      .returning();
  }

  /** Replaces every item, then returns the new set. Used when the user edits a meal. */
  async replaceItems(mealId: string, resolved: readonly ResolvedItem[]): Promise<MealItemRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.delete(mealItems).where(eq(mealItems.mealId, mealId));
      return this.insertItems(tx, mealId, resolved);
    });
  }

  async updateTotals(
    mealId: string,
    totals: CreateMealInput['totals'],
    confidence: number | null,
    nutritionSource: MealRow['nutritionSource'],
  ): Promise<MealRow | undefined> {
    const [updated] = await this.db
      .update(meals)
      .set({
        totalKcal: numeric(totals.kcal),
        totalProteinG: numeric(totals.proteinG),
        totalCarbsG: numeric(totals.carbsG),
        totalFatG: numeric(totals.fatG),
        totalFiberG: numeric(totals.fiberG),
        confidence: confidence === null ? null : confidence.toFixed(3),
        nutritionSource,
        userEdited: true,
      })
      .where(eq(meals.id, mealId))
      .returning();
    return updated;
  }

  async findById(userId: string, mealId: string): Promise<MealWithItems | undefined> {
    const meal = await this.db.query.meals.findFirst({
      where: and(eq(meals.id, mealId), eq(meals.userId, userId), isNull(meals.deletedAt)),
    });
    if (!meal) return undefined;
    return { meal, items: await this.itemsOf(meal.id) };
  }

  private itemsOf(mealId: string): Promise<MealItemRow[]> {
    return this.db
      .select()
      .from(mealItems)
      .where(eq(mealItems.mealId, mealId))
      .orderBy(asc(mealItems.sortOrder), asc(mealItems.id));
  }

  /**
   * Meals for one local day, drafts excluded by default.
   *
   * A draft is not yet something that happened (DATABASE_DESIGN.md §3.4), so it must not
   * pollute the timeline or any total. Only `confirm` promotes it.
   */
  async listForDay(
    userId: string,
    localDate: string,
    options: { includeDrafts?: boolean } = {},
  ): Promise<MealWithItems[]> {
    const conditions = [eq(meals.userId, userId), isNull(meals.deletedAt)];

    if (options.includeDrafts) {
      // Drafts have no event, so they are dated by when they were created.
      conditions.push(
        sql`(${meals.status} = 'draft' or exists (
          select 1 from ${dailyEvents} e
          where e.id = ${meals.eventId} and e.local_date = ${localDate}
        ))`,
      );
    } else {
      conditions.push(eq(meals.status, 'confirmed'));
      conditions.push(
        sql`exists (
          select 1 from ${dailyEvents} e
          where e.id = ${meals.eventId} and e.local_date = ${localDate}
        )`,
      );
    }

    const rows = await this.db
      .select()
      .from(meals)
      .where(and(...conditions))
      .orderBy(asc(meals.createdAt));

    const withItems: MealWithItems[] = [];
    for (const meal of rows) withItems.push({ meal, items: await this.itemsOf(meal.id) });
    return withItems;
  }

  /** Attaches the event created on confirmation and flips the status in one statement. */
  async confirm(userId: string, mealId: string, eventId: string): Promise<MealRow | undefined> {
    const [updated] = await this.db
      .update(meals)
      .set({ status: 'confirmed', eventId, userConfirmed: true })
      .where(
        and(
          eq(meals.id, mealId),
          eq(meals.userId, userId),
          eq(meals.status, 'draft'),
          isNull(meals.deletedAt),
        ),
      )
      .returning();
    return updated;
  }

  async softDelete(userId: string, mealId: string): Promise<MealRow | undefined> {
    const [deleted] = await this.db
      .update(meals)
      .set({ deletedAt: new Date() })
      .where(and(eq(meals.id, mealId), eq(meals.userId, userId), isNull(meals.deletedAt)))
      .returning();
    return deleted;
  }

  /**
   * Nutrition totals across a local date range, aggregated in SQL.
   *
   * Sums the **items**, not the meal totals, so a meal whose own total is stale cannot
   * skew a day. Drafts are excluded — they have no event and did not happen.
   */
  async nutritionByDay(
    userId: string,
    from: string,
    to: string,
  ): Promise<
    Array<{
      localDate: string;
      kcal: number | null;
      proteinG: number | null;
      carbsG: number | null;
      fatG: number | null;
      fiberG: number | null;
      mealsLogged: number;
      distinctFoods: number;
      unresolvedItems: number;
      minConfidence: number | null;
    }>
  > {
    const rows = await this.db
      .select({
        localDate: dailyEvents.localDate,
        // `sum` ignores nulls, so an unresolved item would silently vanish from the
        // total. Counting them separately is what lets the response say the figure is
        // incomplete rather than pretending it is not.
        kcal: sql<number | null>`sum(${mealItems.kcal})::float8`,
        proteinG: sql<number | null>`sum(${mealItems.proteinG})::float8`,
        carbsG: sql<number | null>`sum(${mealItems.carbsG})::float8`,
        fatG: sql<number | null>`sum(${mealItems.fatG})::float8`,
        fiberG: sql<number | null>`sum(${mealItems.fiberG})::float8`,
        mealsLogged: sql<number>`count(distinct ${meals.id})::int`,
        distinctFoods: sql<number>`count(distinct ${mealItems.foodId})::int`,
        unresolvedItems: sql<number>`count(*) filter (where ${mealItems.kcal} is null)::int`,
        minConfidence: sql<number | null>`min(${mealItems.confidence})::float8`,
      })
      .from(meals)
      .innerJoin(dailyEvents, eq(meals.eventId, dailyEvents.id))
      .innerJoin(mealItems, eq(mealItems.mealId, meals.id))
      .where(
        and(
          eq(meals.userId, userId),
          eq(meals.status, 'confirmed'),
          isNull(meals.deletedAt),
          isNull(dailyEvents.deletedAt),
          gte(dailyEvents.localDate, from),
          lte(dailyEvents.localDate, to),
        ),
      )
      .groupBy(dailyEvents.localDate)
      .orderBy(asc(dailyEvents.localDate));

    return rows.map((row) => ({ ...row, localDate: String(row.localDate) }));
  }

  /** Most-logged foods, for the quick-add surface. */
  async frequentFoods(userId: string, limit = 10): Promise<Array<{ foodId: string; uses: number }>> {
    const rows = await this.db
      .select({
        foodId: mealItems.foodId,
        uses: sql<number>`count(*)::int`,
      })
      .from(mealItems)
      .innerJoin(meals, eq(mealItems.mealId, meals.id))
      .where(and(eq(meals.userId, userId), isNull(meals.deletedAt), eq(meals.status, 'confirmed')))
      .groupBy(mealItems.foodId)
      .having(sql`${mealItems.foodId} is not null`)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);

    return rows.filter((row): row is { foodId: string; uses: number } => row.foodId !== null);
  }
}
