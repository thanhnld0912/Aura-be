import { itemConfidence } from './confidence.js';
import type { FoodRepository } from './food-repository.js';
import { toCandidate } from './food-repository.js';
import { calculateNutrients } from './nutrition-calculator.js';
import { resolvePortion, type ResolvedPortion } from './portion-resolver.js';
import type {
  FoodCandidate,
  MealUnit,
  Nutrients,
  NutritionProvider,
  NutritionSource,
  PortionSizeLabel,
} from './types.js';

/**
 * The resolution chain (NUTRITION_ARCHITECTURE.md §4).
 *
 * Order of attempts, first success wins:
 *
 *   1. `user_food_aliases`  this user already corrected this exact phrase   conf 1.00
 *   2. exact match, local   normalised name hit in the VN dataset           conf 0.95
 *   3. fuzzy match, local   trigram similarity over unaccented text         conf 0.70–0.90
 *   4. cached foods         a previous USDA/OFF lookup for this term        conf 0.85
 *   5. USDA search          top hit above the relevance threshold           conf 0.60–0.80
 *   6. Open Food Facts      packaged / branded fallback                     conf 0.50–0.70
 *   7. unresolved           stored with kcal = null                         conf 0.00
 *
 * **Step 7 is the important one.** When nothing resolves, the item is stored with
 * `kcal: null` and surfaced for the user to identify. AURA never fills the gap with a
 * plausible number — that is the whole point of the architecture.
 */

export interface DetectedItem {
  /** What the user or the parser said. Not assumed to be a food name we know. */
  name: string;
  quantity: number;
  unit: MealUnit;
  sizeLabel?: PortionSizeLabel | undefined;
  /** Set when the user picked a specific food, which skips identification entirely. */
  foodId?: string | undefined;
  /** How confident the *identifier* was, when it was a parser or a model. */
  identificationConfidence?: number | undefined;
}

export interface ResolvedItem {
  detectedName: string;
  foodId: string | null;
  displayNameVi: string | null;
  displayNameEn: string | null;
  quantity: number;
  unit: MealUnit;
  gramsResolved: number | null;
  portionId: string | null;
  portionLabel: PortionSizeLabel | null;
  nutrients: Nutrients;
  source: NutritionSource;
  confidence: number;
  /** How this item was resolved, for the response and for debugging a bad match. */
  trace: string;
}

const UNRESOLVED_NUTRIENTS: Nutrients = {
  kcal: null,
  proteinG: null,
  carbsG: null,
  fatG: null,
  fiberG: null,
};

export interface FoodResolverOptions {
  /** Ordered by priority. Local first — see `LocalFoodProvider`. */
  providers: readonly NutritionProvider[];
  repository: FoodRepository;
}

export class FoodResolver {
  private readonly providers: readonly NutritionProvider[];

  constructor(private readonly options: FoodResolverOptions) {
    this.providers = [...options.providers].sort((a, b) => a.priority - b.priority);
  }

  async resolve(item: DetectedItem, userId: string): Promise<ResolvedItem> {
    const candidate = await this.identify(item, userId);

    if (!candidate) {
      // Step 7. No number at all, rather than a plausible one.
      return {
        detectedName: item.name,
        foodId: null,
        displayNameVi: null,
        displayNameEn: null,
        quantity: item.quantity,
        unit: item.unit,
        gramsResolved: null,
        portionId: null,
        portionLabel: null,
        nutrients: UNRESOLVED_NUTRIENTS,
        source: 'unresolved',
        confidence: 0,
        trace: `no provider matched "${item.name}"`,
      };
    }

    const { food, aliasGrams, trace } = candidate;
    const portions = await this.options.repository.portionsOf(food.foodId);

    let portion: ResolvedPortion;
    if (aliasGrams !== null && aliasGrams !== undefined) {
      // The user's remembered correction included a portion, so use it verbatim.
      portion = {
        grams: aliasGrams,
        portionId: null,
        portionLabel: 'custom',
        confidence: 1,
        basis: `remembered portion for "${item.name}"`,
      };
    } else {
      portion = resolvePortion(
        {
          quantity: item.quantity,
          unit: item.unit,
          ...(item.sizeLabel !== undefined ? { sizeLabel: item.sizeLabel } : {}),
        },
        portions,
      );
    }

    const identification = item.foodId
      ? 1 // The user picked this food; identification is not in question.
      : (item.identificationConfidence ?? 1) * food.matchConfidence;

    return {
      detectedName: item.name,
      foodId: food.foodId,
      displayNameVi: food.nameVi,
      displayNameEn: food.nameEn,
      quantity: item.quantity,
      unit: item.unit,
      gramsResolved: portion.grams,
      portionId: portion.portionId,
      portionLabel: portion.portionLabel,
      nutrients: calculateNutrients(food.per100g, portion.grams),
      source: food.provider,
      confidence: itemConfidence({
        identification,
        portion: portion.confidence,
        dataQuality: food.dataQuality,
      }),
      trace: `${trace}; ${portion.basis}`,
    };
  }

  /** Steps 1–6. Returns the winning candidate, or nothing. */
  private async identify(
    item: DetectedItem,
    userId: string,
  ): Promise<{ food: FoodCandidate; aliasGrams?: number | null; trace: string } | null> {
    // Step 0 — the user named an exact food. Not in the documented chain because it is
    // not identification at all: there is nothing to guess.
    if (item.foodId) {
      const row = await this.options.repository.findById(item.foodId);
      if (row) return { food: toCandidate(row, 1, 'exact'), trace: 'food chosen by the user' };
      return null;
    }

    // Step 1 — this user has corrected this exact phrase before.
    const alias = await this.options.repository.findAlias(userId, item.name);
    if (alias) {
      const row = await this.options.repository.findById(alias.foodId);
      if (row) {
        return {
          food: toCandidate(row, 1, 'alias'),
          aliasGrams: alias.defaultGrams,
          trace: `remembered: you previously matched "${item.name}" to ${row.canonicalName}`,
        };
      }
    }

    // Steps 2–6 — each provider in priority order, first hit wins.
    for (const provider of this.providers) {
      const hits = await provider.search(item.name, { limit: 3 });
      const best = hits[0];
      if (best) {
        return { food: best, trace: `${provider.name} ${best.matchedBy} match` };
      }
    }

    return null;
  }
}
