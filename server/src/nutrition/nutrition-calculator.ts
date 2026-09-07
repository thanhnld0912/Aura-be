import type { Nutrients, NutrientsPer100g } from './types.js';

/**
 * The arithmetic. Deliberately the least clever file in the system.
 *
 * Nothing here calls a model, a provider or a database — it takes grams and per-100g
 * figures and multiplies. That is the whole point of the architecture: whatever
 * identified the food, the number the user sees is reproducible from two inputs anyone
 * can check (NUTRITION_ARCHITECTURE.md §1).
 */

/**
 * `null` propagates. A missing nutrient stays missing rather than becoming zero — zero is
 * a claim ("this food has no fibre"), absence is the truth ("we do not know").
 */
function scale(value: number | null, grams: number): number | null {
  if (value === null) return null;
  return round((value * grams) / 100);
}

/**
 * Two decimals. Enough precision that summing a day's items does not visibly drift, and
 * not so much that the response implies a measurement that was never made.
 */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateNutrients(per100g: NutrientsPer100g, grams: number): Nutrients {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new RangeError(`grams must be a non-negative finite number, got ${grams}`);
  }

  return {
    kcal: scale(per100g.kcal, grams),
    proteinG: scale(per100g.proteinG, grams),
    carbsG: scale(per100g.carbsG, grams),
    fatG: scale(per100g.fatG, grams),
    fiberG: scale(per100g.fiberG, grams),
  };
}

/**
 * Adds nutrient sets.
 *
 * A `null` among the values makes the total `null` rather than silently contributing
 * zero: if one item's protein is unknown, the meal's protein total is unknown too, and
 * reporting the sum of the rest as if it were complete would be a quiet lie. This is the
 * same stance as `unresolved` items carrying `kcal: null` (§4 step 7).
 */
export function sumNutrients(items: readonly Nutrients[]): Nutrients {
  const keys = ['kcal', 'proteinG', 'carbsG', 'fatG', 'fiberG'] as const;
  const total: Record<(typeof keys)[number], number | null> = {
    kcal: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    fiberG: 0,
  };

  for (const key of keys) {
    let running: number | null = 0;
    for (const item of items) {
      const value = item[key];
      if (value === null || running === null) {
        running = null;
        break;
      }
      running += value;
    }
    total[key] = running === null ? null : round(running);
  }

  return total;
}

/** An empty meal has zero of everything, which is a fact rather than an absence. */
export const EMPTY_NUTRIENTS: Nutrients = {
  kcal: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  fiberG: 0,
};
