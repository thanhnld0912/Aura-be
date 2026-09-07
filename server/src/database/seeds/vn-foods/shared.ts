import type { DataQuality, NutrientsPer100g, PortionDefinition } from '../../../nutrition/types.js';

/**
 * The Vietnamese food dataset — `provider='local'` rows, authored rather than fetched
 * (NUTRITION_ARCHITECTURE.md §3).
 *
 * ## Why this exists
 *
 * Searching USDA for "thịt kho" returns nothing useful. Searching it for "pork, braised"
 * returns a US-cut approximation of a dish cooked in caramel and fish sauce. For the target
 * user most meals are Vietnamese home cooking, so this is the *primary* source and the
 * external APIs fill the long tail.
 *
 * ## Provenance, honestly
 *
 * Every row records how its figures were reached. Three bases, and the `dataQuality` label
 * says which:
 *
 * - **`high`** — single-ingredient foods whose composition is well established and
 *   stable across sources (white rice, chicken breast, a hen's egg, a banana). Values are
 *   consistent with USDA FoodData Central standard-reference entries for the same item.
 * - **`medium`** — composed Vietnamese dishes, computed from a typical home or street
 *   recipe by summing component ingredients and dividing by the finished weight. A recipe
 *   estimate, and labelled as one: the same dish varies by household, region and cook.
 * - **`low`** — dishes where the recipe itself varies so widely that the figure is a
 *   rough order of magnitude (regional specialities, sweetened drinks with no standard
 *   sugar level).
 *
 * **These are not laboratory measurements.** They have not been checked against the
 * Vietnamese National Institute of Nutrition composition tables, which is the right source
 * for a production dataset and the obvious next improvement. What they are is defensible,
 * traceable and correctable: every row carries its basis, and a user's correction always
 * outranks it.
 *
 * ## Portions
 *
 * Household measures are the real unit of Vietnamese meal logging (§3). Every food carries
 * the measures people actually use, and the gram values follow the presets below unless the
 * food needs its own.
 */

export interface SeedFood {
  /** Stable slug. Becomes `foods.external_id` and never changes once shipped. */
  externalId: string;
  nameVi: string;
  nameEn: string;
  category: FoodCategory;
  per100g: NutrientsPer100g;
  dataQuality: DataQuality;
  /** How the figures were reached. Never empty. */
  sourceReference: string;
  portions: PortionDefinition[];
  /**
   * Set on the food a bare, ambiguous term should mean — "cơm" is cơm trắng, "phở" is
   * phở bò. Curated rather than derived, because it encodes what people actually mean.
   */
  searchPriority?: number;
}

export type FoodCategory =
  | 'rice_grain'
  | 'noodle_soup'
  | 'noodle_dry'
  | 'bread'
  | 'meat'
  | 'seafood'
  | 'egg'
  | 'tofu_bean'
  | 'vegetable'
  | 'soup'
  | 'fruit'
  | 'dairy'
  | 'drink'
  | 'snack'
  | 'condiment'
  | 'street_food'
  | 'breakfast';

/** Portion presets, so the gram values behind a category are stated once. */
export const P = {
  /** Cooked rice and similar: the chén is the unit of every Vietnamese meal. */
  rice: (): PortionDefinition[] => [
    { label: 'half bowl', labelVi: 'nửa chén', grams: 75 },
    { label: '1 bowl', labelVi: '1 chén', grams: 150, isDefault: true },
    { label: 'large bowl', labelVi: '1 tô', grams: 300 },
  ],
  /** Noodle soups are served in a tô, and the size is the thing people choose. */
  noodleSoup: (): PortionDefinition[] => [
    { label: 'small bowl', labelVi: 'tô nhỏ', grams: 400 },
    { label: 'regular bowl', labelVi: 'tô thường', grams: 500, isDefault: true },
    { label: 'large bowl', labelVi: 'tô đặc biệt', grams: 650 },
  ],
  /** Dry noodle dishes come on a plate or in a smaller bowl. */
  noodleDry: (): PortionDefinition[] => [
    { label: 'small plate', labelVi: 'đĩa nhỏ', grams: 250 },
    { label: '1 plate', labelVi: '1 đĩa', grams: 350, isDefault: true },
  ],
  /** Món mặn — the savoury dish shared at the centre of the table. */
  mainDish: (grams = 100): PortionDefinition[] => [
    { label: '1 serving', labelVi: '1 phần', grams, isDefault: true },
    { label: '1 piece', labelVi: '1 miếng', grams: Math.round(grams * 0.4) },
  ],
  /** Canh is drunk from a chén alongside rice. */
  soup: (): PortionDefinition[] => [
    { label: '1 bowl', labelVi: '1 chén', grams: 200, isDefault: true },
    { label: 'large bowl', labelVi: '1 tô', grams: 350 },
  ],
  vegetable: (): PortionDefinition[] => [
    { label: '1 serving', labelVi: '1 phần', grams: 100, isDefault: true },
    { label: '1 plate', labelVi: '1 đĩa', grams: 150 },
  ],
  /** Whole fruit: the piece is the unit, so its weight is the food's own. */
  wholeFruit: (grams: number): PortionDefinition[] => [
    { label: '1 piece', labelVi: '1 quả', grams, isDefault: true },
    { label: '100 g', grams: 100 },
  ],
  drink: (grams = 240): PortionDefinition[] => [
    { label: '1 glass', labelVi: '1 ly', grams, isDefault: true },
    { label: '1 bottle', labelVi: '1 chai', grams: 500 },
  ],
  piece: (grams: number, labelVi = '1 cái'): PortionDefinition[] => [
    { label: '1 piece', labelVi, grams, isDefault: true },
  ],
} as const;

export const n = (
  kcal: number,
  proteinG: number,
  carbsG: number,
  fatG: number,
  fiberG: number,
): NutrientsPer100g => ({ kcal, proteinG, carbsG, fatG, fiberG });

/** Shorthand for the two provenance strings used most. */
export const USDA = (item: string): string =>
  `USDA FoodData Central standard reference, generic entry for ${item}; single ingredient, values stable across sources`;
export const RECIPE = (basis: string): string =>
  `Component-derived: ${basis}. Summed from ingredient values and divided by finished weight; a typical-recipe estimate, not a measurement`;

