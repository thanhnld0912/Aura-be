import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { toLocalDate, todayIn } from '../../lib/local-date.js';
import { mealConfidence } from '../../nutrition/confidence.js';
import type { FoodRepository } from '../../nutrition/food-repository.js';
import type { DetectedItem, FoodResolver, ResolvedItem } from '../../nutrition/food-resolver.js';
import { sumNutrients } from '../../nutrition/nutrition-calculator.js';
import type { MealParser } from '../../nutrition/parser/meal-parser.js';
import type { MealUnit, Nutrients, PortionSizeLabel } from '../../nutrition/types.js';
import type { DailyEventsService, DayRefresher } from '../daily-events/daily-events.service.js';
import type { MealRow, MealWithItems, MealsRepository } from './meals.repository.js';

/**
 * The meal lifecycle.
 *
 * The rule the whole module exists to enforce: **the client never supplies nutrition.**
 * A request names a food and an amount; the server resolves both and does the arithmetic.
 * There is no field in any input schema through which a caller could assert a calorie
 * count, which is what makes "the frontend cannot send `{ calories: 900 }`" a property of
 * the type system rather than a rule someone has to remember.
 */

export interface MealItemInput {
  /** Either a chosen food… */
  foodId?: string | undefined;
  /** …or a phrase to resolve. One of the two is required. */
  name?: string | undefined;
  quantity: number;
  unit: MealUnit;
  sizeLabel?: PortionSizeLabel | undefined;
}

export interface CreateMealCommand {
  mealType: MealRow['mealType'];
  items: MealItemInput[];
  /** `draft` produces something to review; `confirmed` logs it immediately. */
  status?: 'draft' | 'confirmed';
  occurredAt?: Date | undefined;
  rawInput?: string | undefined;
}

export interface MealServiceDeps {
  repository: MealsRepository;
  resolver: FoodResolver;
  foods: FoodRepository;
  events: DailyEventsService;
  getDayRefresher: () => DayRefresher;
  parser: MealParser;
  now?: () => Date;
}

export class MealsService {
  private readonly now: () => Date;

  constructor(private readonly deps: MealServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async create(
    userId: string,
    timeZone: string,
    command: CreateMealCommand,
  ): Promise<MealWithItems> {
    if (command.items.length === 0) {
      throw new ValidationError('items: a meal needs at least one item', [
        { path: 'items', issue: 'too_small' },
      ]);
    }

    const resolved = await this.resolveAll(userId, command.items);
    const status = command.status ?? 'confirmed';
    const occurredAt = command.occurredAt ?? this.now();

    // A confirmed meal is something that happened, so it gets an event; a draft is not,
    // so it must not (DATABASE_DESIGN.md §3.4). The database check enforces the pairing;
    // this is where the intent lives.
    const eventId =
      status === 'confirmed'
        ? (await this.createEvent(userId, timeZone, command.mealType, occurredAt)).id
        : null;

    const created = await this.deps.repository.create({
      userId,
      mealType: command.mealType,
      status,
      rawInput: command.rawInput ?? null,
      eventId,
      totals: this.totalsOf(resolved),
      confidence: mealConfidence(resolved.map((item) => item.confidence)),
      nutritionSource: aggregateSource(resolved),
      items: resolved,
    });

    if (eventId) {
      await this.deps
        .getDayRefresher()
        .refresh(userId, toLocalDate(occurredAt, timeZone), timeZone);
    }

    return created;
  }

  /**
   * Natural language to a **draft**, never straight to a logged meal.
   *
   * Parsing is the least certain step in the pipeline, so its output is something the
   * user reviews rather than something that silently becomes their data (§16 of the
   * Phase 3 brief; NUTRITION_ARCHITECTURE.md §4).
   */
  async parseToDraft(
    userId: string,
    timeZone: string,
    text: string,
    mealType: MealRow['mealType'],
  ): Promise<{ meal: MealWithItems; ambiguous: string[]; parser: string }> {
    // The caller's identity travels with the parse: a model-backed parser has to meter
    // the call against the authenticated user, and it must never read that from `text`.
    const parsed = await this.deps.parser.parse(text, { userId });

    if (parsed.items.length === 0) {
      throw new ValidationError('text: no foods could be read from that', [
        { path: 'text', issue: 'unparseable' },
      ]);
    }

    const resolved: ResolvedItem[] = [];
    for (const item of parsed.items) {
      resolved.push(
        await this.deps.resolver.resolve(
          {
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            ...(item.sizeLabel !== undefined ? { sizeLabel: item.sizeLabel } : {}),
            // The parser's confidence in its *reading* feeds the item's confidence, so a
            // guessed portion cannot present as a certain one.
            identificationConfidence: item.confidence,
          },
          userId,
        ),
      );
    }

    const meal = await this.deps.repository.create({
      userId,
      mealType,
      status: 'draft',
      rawInput: text,
      eventId: null,
      totals: this.totalsOf(resolved),
      confidence: mealConfidence(resolved.map((item) => item.confidence)),
      nutritionSource: aggregateSource(resolved),
      items: resolved,
    });

    return { meal, ambiguous: parsed.ambiguous, parser: parsed.parser };
  }

  async get(userId: string, mealId: string): Promise<MealWithItems> {
    const found = await this.deps.repository.findById(userId, mealId);
    if (!found) throw new NotFoundError();
    return found;
  }

  listForDay(userId: string, localDate: string, includeDrafts = false): Promise<MealWithItems[]> {
    return this.deps.repository.listForDay(userId, localDate, { includeDrafts });
  }

  today(userId: string, timeZone: string, includeDrafts = false): Promise<MealWithItems[]> {
    return this.listForDay(userId, todayIn(timeZone, this.now()), includeDrafts);
  }

  /**
   * The user corrects a meal.
   *
   * Two things happen beyond re-resolving: the item confidences are pinned to 1.0,
   * because the user outranks every provider (§6), and each correction that renamed a
   * phrase is remembered as an alias — the loop that makes AURA improve with use.
   */
  async replaceItems(
    userId: string,
    mealId: string,
    timeZone: string,
    items: MealItemInput[],
  ): Promise<MealWithItems> {
    const existing = await this.get(userId, mealId);
    if (items.length === 0) {
      throw new ValidationError('items: a meal needs at least one item', [
        { path: 'items', issue: 'too_small' },
      ]);
    }

    const resolved = await this.resolveAll(userId, items);

    // Remember what the user chose, keyed on what the parser originally read.
    for (const [index, item] of items.entries()) {
      const original = existing.items[index];
      if (item.foodId && original && original.detectedName !== item.name) {
        await this.deps.foods.rememberAlias(
          userId,
          original.detectedName,
          item.foodId,
          resolved[index]?.gramsResolved ?? null,
        );
      }
    }

    const confirmed = resolved.map((item) => ({ ...item, confidence: 1, source: 'user' as const }));

    await this.deps.repository.replaceItems(mealId, confirmed);
    await this.deps.repository.updateTotals(
      mealId,
      this.totalsOf(confirmed),
      mealConfidence(confirmed.map((item) => item.confidence)),
      'user',
    );

    if (existing.meal.eventId) {
      const event = await this.deps.events.get(userId, existing.meal.eventId);
      await this.deps.getDayRefresher().refresh(userId, event.localDate, timeZone);
    }

    return this.get(userId, mealId);
  }

  /** Promotes a draft into something that happened. */
  async confirm(userId: string, mealId: string, timeZone: string): Promise<MealWithItems> {
    const existing = await this.get(userId, mealId);
    if (existing.meal.status === 'confirmed') {
      throw new ConflictError('That meal is already confirmed');
    }
    if (existing.meal.status === 'discarded') {
      throw new ConflictError('That meal was discarded');
    }

    const occurredAt = this.now();
    const event = await this.createEvent(userId, timeZone, existing.meal.mealType, occurredAt);

    const confirmed = await this.deps.repository.confirm(userId, mealId, event.id);
    if (!confirmed) throw new ConflictError('That meal is no longer a draft');

    await this.deps.getDayRefresher().refresh(userId, event.localDate, timeZone);
    return this.get(userId, mealId);
  }

  async softDelete(userId: string, mealId: string, timeZone: string): Promise<void> {
    const existing = await this.get(userId, mealId);
    const deleted = await this.deps.repository.softDelete(userId, mealId);
    if (!deleted) throw new NotFoundError();

    // Removing the meal removes the event it was attached to, and with it the day's count.
    if (existing.meal.eventId) {
      const event = await this.deps.events.get(userId, existing.meal.eventId).catch(() => null);
      if (event) {
        await this.deps.events.softDelete(userId, event.id, timeZone);
      }
    }
  }

  private async resolveAll(userId: string, items: MealItemInput[]): Promise<ResolvedItem[]> {
    const resolved: ResolvedItem[] = [];

    for (const [index, item] of items.entries()) {
      if (!item.foodId && !item.name) {
        throw new ValidationError(`items.${index}: needs either foodId or name`, [
          { path: `items.${index}`, issue: 'missing_food' },
        ]);
      }

      const detected: DetectedItem = {
        name: item.name ?? '',
        quantity: item.quantity,
        unit: item.unit,
        ...(item.sizeLabel !== undefined ? { sizeLabel: item.sizeLabel } : {}),
        ...(item.foodId !== undefined ? { foodId: item.foodId } : {}),
      };

      resolved.push(await this.deps.resolver.resolve(detected, userId));
    }

    return resolved;
  }

  private totalsOf(items: readonly ResolvedItem[]): Nutrients {
    return sumNutrients(items.map((item) => item.nutrients));
  }

  private createEvent(
    userId: string,
    timeZone: string,
    mealType: MealRow['mealType'],
    occurredAt: Date,
  ) {
    return this.deps.events.createMealEvent(userId, timeZone, {
      title: MEAL_TITLES[mealType],
      occurredAt,
    });
  }
}

/** Neutral, descriptive titles. Nothing here evaluates the meal. */
const MEAL_TITLES: Record<MealRow['mealType'], string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
  drink: 'Drink',
};

/**
 * A meal's `nutrition_source` is the aggregate of its items'.
 *
 * `unresolved` wins if anything is unresolved, because a total that is missing an item is
 * more honestly described by its weakest link than by its strongest.
 */
function aggregateSource(items: readonly ResolvedItem[]): MealRow['nutritionSource'] {
  if (items.some((item) => item.source === 'unresolved')) return 'unresolved';
  const sources = new Set(items.map((item) => item.source));
  if (sources.size === 1) {
    const [only] = [...sources];
    return only ?? 'local';
  }
  return 'local';
}
