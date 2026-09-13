import type { ParseContext, ParsedMeal } from './meal-parser.js';

/**
 * Reading a meal from a photograph.
 *
 * A sibling of `MealParser` rather than an overload of it, because the two fail
 * differently. A sentence can always be read again by the deterministic parser — the
 * text is still there. A photo has no deterministic reading at all, so there is nothing
 * to fall back to and a failure has to surface. One `parse(text)` signature for both
 * would hide exactly that difference.
 *
 * It returns the same `ParsedMeal`, and so inherits the same boundary: an item has a
 * name, a count, a unit and a confidence, and no field that could carry a calorie. Every
 * number on the resulting draft still comes from the food database.
 */

/** An image that has already been through `lib/images.ts` — never an upload as received. */
export interface MealImage {
  /** Re-encoded bytes, with all metadata including GPS removed. */
  data: Buffer;
  mimeType: string;
  /** Length of `data`, for `ai_runs.request_meta.imageBytes`. */
  bytes: number;
}

export interface ImageMealInput {
  image: MealImage;
  /** Optional, typed by the user, and as untrusted as any other user text. */
  description?: string | undefined;
}

export interface ImageMealParser {
  readonly name: string;
  /** `context` is required: a model-backed reading is always metered to its caller. */
  parse(input: ImageMealInput, context: ParseContext): Promise<ParsedMeal>;
}
