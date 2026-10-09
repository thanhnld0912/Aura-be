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
 * A portion's identity within its food, stable across re-seeds: the English label,
 * NFC-normalised, trimmed, whitespace-collapsed and lower-cased. `seedFoods` matches
 * existing `food_portions` rows on it so their ids survive, because `meal_items.portion_id`
 * points at them. Changing a label's case or spacing is an edit; changing its words is a
 * new portion.
 */
export function portionKey(label: string): string {
  return label.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

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
    const defaults = food.portions.filter((portion) => portion.isDefault).length;
    if (defaults === 0) {
      problems.push(`${food.externalId}: no default portion`);
    } else if (defaults > 1) {
      problems.push(`${food.externalId}: ${defaults} default portions — exactly one is the default`);
    }
    // The label is the portion's identity across re-seeds (`portionKey`), so it must be
    // unique per food and written the way it will be compared.
    const seenPortions = new Set<string>();
    for (const portion of food.portions) {
      if (!(portion.grams > 0)) {
        problems.push(`${food.externalId}: portion "${portion.label}" has grams ${portion.grams}`);
      }
      if (portion.label.trim().length === 0 || portion.label !== portion.label.trim()) {
        problems.push(`${food.externalId}: portion label ${JSON.stringify(portion.label)} is empty or padded`);
      }
      const key = portionKey(portion.label);
      if (seenPortions.has(key)) {
        problems.push(`${food.externalId}: duplicate portion "${portion.label}" — a portion's label is its identity`);
      }
      seenPortions.add(key);
    }
  }

  return problems;
}
