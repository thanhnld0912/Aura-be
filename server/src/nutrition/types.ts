/**
 * The nutrition domain's vocabulary.
 *
 * `nutrition/` is a library: no HTTP awareness, no auth awareness (ARCHITECTURE.md §5).
 * It knows about foods, portions and arithmetic, and nothing about who is asking.
 */

export type DataQuality = 'high' | 'medium' | 'low';

/** Where a number came from. `user` always wins (DATABASE_DESIGN.md §3.5). */
export type NutritionSource =
  | 'vision'
  | 'text'
  | 'quick'
  | 'usda'
  | 'off'
  | 'local'
  | 'user'
  | 'unresolved';

export type PortionSizeLabel = 'small' | 'medium' | 'large' | 'custom';

/**
 * The units a meal item can be logged in. Household measures come first because they are
 * what people actually say — "2 chén cơm", never "300 grams of cooked rice"
 * (NUTRITION_ARCHITECTURE.md §3).
 */
export const MEAL_UNITS = ['g', 'ml', 'bowl', 'piece', 'plate', 'serving'] as const;
export type MealUnit = (typeof MEAL_UNITS)[number];

/** Per-100g figures. `null` means "not known", never "zero". */
export interface NutrientsPer100g {
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
}

/** The same nutrients for an actual amount eaten. */
export type Nutrients = NutrientsPer100g;

export interface PortionDefinition {
  id?: string;
  /** English label, e.g. `1 bowl`. */
  label: string;
  /** What the user would say, e.g. `1 chén`. */
  labelVi?: string | undefined;
  grams: number;
  isDefault?: boolean;
}

/** A food as a provider knows it, before it is stored. */
export interface FoodRecord {
  externalId: string;
  canonicalName: string;
  nameVi?: string | undefined;
  nameEn: string;
  category: string;
  per100g: NutrientsPer100g;
  portions?: PortionDefinition[];
  dataQuality: DataQuality;
  /** How the figures were arrived at. Free text, but never empty for local rows. */
  sourceReference?: string | undefined;
}

/** A search hit, with how confident the *identification* is. */
export interface FoodCandidate {
  foodId: string;
  canonicalName: string;
  nameVi: string | null;
  nameEn: string;
  category: string | null;
  provider: 'local' | 'usda' | 'off';
  dataQuality: DataQuality;
  per100g: NutrientsPer100g;
  /** 0..1 — how well this row matches what was asked for. */
  matchConfidence: number;
  /** How the match was made, for the resolution trace. */
  matchedBy: 'alias' | 'exact' | 'fuzzy' | 'cached' | 'usda' | 'off';
}

export interface SearchOptions {
  limit?: number;
}

/**
 * Providers are interchangeable by design (NUTRITION_ARCHITECTURE.md §2). Meal services
 * depend on this interface, never on USDA or Open Food Facts directly, so a provider can
 * be replaced or removed without touching the meal domain.
 */
export interface NutritionProvider {
  readonly name: 'local' | 'usda' | 'off';
  /** Lower wins. Local is 1 — it is the only source that knows what *cá kho tộ* is. */
  readonly priority: number;
  readonly dataQuality: DataQuality;

  search(query: string, options?: SearchOptions): Promise<FoodCandidate[]>;
  getById(foodId: string): Promise<FoodCandidate | null>;
  getByBarcode?(barcode: string): Promise<FoodCandidate | null>;
}
