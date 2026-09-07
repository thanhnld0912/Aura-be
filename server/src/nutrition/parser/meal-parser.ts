import type { MealUnit, PortionSizeLabel } from '../types.js';

/**
 * Turning "Tôi ăn 2 chén cơm với thịt kho trứng và canh rau" into structured candidates.
 *
 * ## The boundary this interface exists to hold
 *
 * A parser is responsible for **language**: which foods were mentioned, how many, in what
 * measure, and how sure it is. It is *not* responsible for nutrition. Nothing in
 * `ParsedItem` can carry a calorie, a macro or a gram weight, so an implementation
 * physically cannot return one — the resolver and calculator own that, and they take
 * their numbers from the food database (NUTRITION_ARCHITECTURE.md §1).
 *
 * That matters most for the implementation this interface is *waiting* for. When Claude
 * parses Vietnamese in Phase 4, it plugs in here and inherits the constraint: it can say
 * "the user mentioned cơm, two bowls of it", and it has no channel through which to
 * assert that this is 390 kcal.
 *
 * Phase 3 ships `RuleBasedMealParser`, which needs no model, no network and no key.
 */
export interface ParsedItem {
  /** The food phrase as the user said it, for the resolver to match and for aliasing. */
  name: string;
  quantity: number;
  unit: MealUnit;
  sizeLabel?: PortionSizeLabel | undefined;
  /** 0..1 — how confident the parser is that it read this phrase correctly. */
  confidence: number;
}

export interface ParsedMeal {
  items: ParsedItem[];
  /** Phrases that looked like food but could not be read as a quantity + name. */
  ambiguous: string[];
  /** Which implementation produced this, for the response and for `ai_runs` later. */
  parser: string;
}

export interface MealParser {
  readonly name: string;
  parse(text: string, locale?: 'vi' | 'en'): Promise<ParsedMeal>;
}
