import { normalizeFoodName } from '../../../nutrition/normalize.js';
import { DRINKS_AND_SNACKS } from './drinks-snacks.js';
import { HOME_DISHES } from './home-dishes.js';
import { NOODLE_DISHES } from './noodles.js';
import { PRODUCE } from './produce.js';
import { PROTEINS } from './proteins.js';
import type { SeedFood } from './shared.js';
import { STAPLES } from './staples.js';

export type { FoodCategory, SeedFood } from './shared.js';

/**
 * The complete local dataset.
 *
 * Split by category rather than kept as one list, because the interesting question about
 * a row is always "what is the basis for this figure", and that is answered per category:
 * staples and plain cuts are reference values, composed dishes are recipe arithmetic.
 */
export const VN_FOODS: readonly SeedFood[] = [
  ...STAPLES,
  ...NOODLE_DISHES,
  ...PROTEINS,
  ...HOME_DISHES,
  ...PRODUCE,
  ...DRINKS_AND_SNACKS,
];

/**
 * Fails loudly on a malformed dataset rather than seeding it.
 *
 * Run by the seeder and asserted in the tests. A duplicate `externalId` would silently
 * overwrite a food on re-seed; a food with no default portion would resolve "1 serving"
 * to a category fallback instead of its own measure; negative energy is a typo. None of
 * these are worth discovering from a user's meal total.
 */
export function validateDataset(foods: readonly SeedFood[] = VN_FOODS): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const food of foods) {
    if (seenIds.has(food.externalId)) problems.push(`duplicate externalId: ${food.externalId}`);
    seenIds.add(food.externalId);

    const normalized = normalizeFoodName(food.nameVi);
    if (seenNames.has(normalized)) problems.push(`duplicate Vietnamese name: ${food.nameVi}`);
    seenNames.add(normalized);

    if (!food.sourceReference || food.sourceReference.trim().length === 0) {
      problems.push(`${food.externalId}: no source reference — every figure must state its basis`);
    }

    const { kcal, proteinG, carbsG, fatG, fiberG } = food.per100g;
    for (const [key, value] of Object.entries({ kcal, proteinG, carbsG, fatG, fiberG })) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        problems.push(`${food.externalId}: ${key} is ${String(value)}`);
      }
    }

    // Macros cannot outweigh the food itself.
    const macroGrams = (proteinG ?? 0) + (carbsG ?? 0) + (fatG ?? 0);
    if (macroGrams > 100.5) {
      problems.push(`${food.externalId}: macros sum to ${macroGrams} g per 100 g`);
    }

    if (food.portions.length === 0) {
      problems.push(`${food.externalId}: no portions — household measures are the point`);
    }
    if (!food.portions.some((portion) => portion.isDefault)) {
      problems.push(`${food.externalId}: no default portion`);
    }
    for (const portion of food.portions) {
      if (!(portion.grams > 0)) {
        problems.push(`${food.externalId}: portion "${portion.label}" has grams ${portion.grams}`);
      }
    }
  }

  return problems;
}
