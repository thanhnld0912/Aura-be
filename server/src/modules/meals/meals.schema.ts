import { z } from 'zod';
import { instantSchema, localDateSchema } from '../../lib/api-schemas.js';
import { confidenceBand } from '../../nutrition/confidence.js';
import { MEAL_UNITS } from '../../nutrition/types.js';
import type { MealWithItems } from './meals.repository.js';

/** `/api/meals` — request and response contracts. */

export const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'drink']);
export const unitSchema = z.enum(MEAL_UNITS);
export const sizeLabelSchema = z.enum(['small', 'medium', 'large', 'custom']);

/**
 * A meal item as the client may describe it.
 *
 * Note what is **absent**: there is no `kcal`, no `protein`, no `grams`. A caller can say
 * *what* and *how much*, and nothing else. The server resolves the food, converts the
 * portion and does the arithmetic, so a client cannot assert a nutrition value even by
 * accident — `.strict()` turns the attempt into a 400 rather than a silent no-op.
 */
export const mealItemInputSchema = z
  .object({
    foodId: z.string().uuid().optional(),
    name: z.string().min(1).max(120).optional(),
    quantity: z.number().positive().max(100),
    unit: unitSchema,
    sizeLabel: sizeLabelSchema.optional(),
  })
  .strict()
  .refine((item) => item.foodId !== undefined || item.name !== undefined, {
    message: 'either foodId or name is required',
  });

export const createMealSchema = z
  .object({
    mealType: mealTypeSchema,
    items: z.array(mealItemInputSchema).min(1).max(30),
    status: z.enum(['draft', 'confirmed']).optional(),
    occurredAt: instantSchema.optional(),
  })
  .strict();

export const updateMealSchema = z
  .object({ items: z.array(mealItemInputSchema).min(1).max(30) })
  .strict();

export const parseMealSchema = z
  .object({
    text: z.string().min(1).max(1000),
    mealType: mealTypeSchema.default('lunch'),
  })
  .strict();

export const mealQuerySchema = z
  .object({
    date: localDateSchema.optional(),
    includeDrafts: z.enum(['true', 'false']).optional(),
  })
  .strict();

/**
 * Energy is `.optional()` in the schema on purpose.
 *
 * When `preferences.showCalories` is false the field is **omitted from the payload**, not
 * set to null and not hidden by the client. The Zod serializer only emits declared keys,
 * so an absent value never reaches the browser at all — which is the only reliable way to
 * honour the setting (NUTRITION_ARCHITECTURE.md §8). A value that reaches the client will
 * eventually reach a UI surface.
 */
const nutrientsSchema = z.object({
  kcal: z.number().nullable().optional(),
  proteinG: z.number().nullable(),
  carbsG: z.number().nullable(),
  fatG: z.number().nullable(),
  fiberG: z.number().nullable(),
});

export const mealItemSchema = z.object({
  id: z.string().uuid(),
  foodId: z.string().uuid().nullable(),
  detectedName: z.string(),
  displayNameVi: z.string().nullable(),
  displayNameEn: z.string().nullable(),
  quantity: z.number(),
  unit: z.string(),
  gramsResolved: z.number().nullable(),
  portionLabel: z.string().nullable(),
  nutrition: nutrientsSchema,
  /** Where the numbers came from — `unresolved` means there are none. */
  source: z.string(),
  confidence: z.number(),
  confidenceBand: z.enum(['confident', 'estimate', 'uncertain', 'unresolved']),
  userConfirmed: z.boolean(),
});

export const mealSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  mealType: mealTypeSchema,
  status: z.enum(['draft', 'confirmed', 'discarded']),
  rawInput: z.string().nullable(),
  items: z.array(mealItemSchema),
  totals: nutrientsSchema,
  confidence: z.number().nullable(),
  confidenceBand: z.enum(['confident', 'estimate', 'uncertain', 'unresolved']),
  userConfirmed: z.boolean(),
  userEdited: z.boolean(),
  /** Required by the schema and always true: these are estimates, never measurements. */
  isEstimate: z.literal(true),
  createdAt: z.string(),
  /** Items nothing could be found for. The UI asks rather than inventing a number. */
  unresolved: z.array(z.string()),
  notice: z.string(),
});

export const mealListSchema = z.object({ data: z.array(mealSchema) });

export const parsedMealSchema = z.object({
  meal: mealSchema,
  /** Fragments the parser could not read as a food. */
  ambiguous: z.array(z.string()),
  parser: z.string(),
});

/** The standing caveat. Never omitted, and deliberately not phrased as a warning. */
export const ESTIMATE_NOTICE =
  'Nutrition figures are estimates based on typical portions — adjust anything that looks off.';

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export interface SerializeOptions {
  /** From `user_preferences`. False omits energy entirely. */
  showCalories: boolean;
}

export function toMealResponse(
  found: MealWithItems,
  options: SerializeOptions,
): z.infer<typeof mealSchema> {
  const { meal, items } = found;

  const nutrition = (row: {
    kcal: string | null;
    proteinG: string | null;
    carbsG: string | null;
    fatG: string | null;
    fiberG: string | null;
  }): z.infer<typeof nutrientsSchema> => ({
    // Spread rather than assign: when the setting is off the key is not present at all.
    ...(options.showCalories ? { kcal: toNumber(row.kcal) } : {}),
    proteinG: toNumber(row.proteinG),
    carbsG: toNumber(row.carbsG),
    fatG: toNumber(row.fatG),
    fiberG: toNumber(row.fiberG),
  });

  const confidence = meal.confidence === null ? null : Number(meal.confidence);

  return {
    id: meal.id,
    eventId: meal.eventId,
    mealType: meal.mealType,
    status: meal.status,
    rawInput: meal.rawInput,
    items: items.map((item) => ({
      id: item.id,
      foodId: item.foodId,
      detectedName: item.detectedName,
      displayNameVi: item.displayNameVi,
      displayNameEn: item.displayNameEn,
      quantity: Number(item.quantity),
      unit: item.unit,
      gramsResolved: toNumber(item.gramsResolved),
      portionLabel: item.portionLabel,
      nutrition: nutrition({
        kcal: item.kcal,
        proteinG: item.proteinG,
        carbsG: item.carbsG,
        fatG: item.fatG,
        fiberG: item.fiberG,
      }),
      source: item.source,
      confidence: Number(item.confidence),
      confidenceBand: confidenceBand(
        item.source === 'unresolved' ? null : Number(item.confidence),
      ),
      userConfirmed: item.userConfirmed,
    })),
    totals: nutrition({
      kcal: meal.totalKcal,
      proteinG: meal.totalProteinG,
      carbsG: meal.totalCarbsG,
      fatG: meal.totalFatG,
      fiberG: meal.totalFiberG,
    }),
    confidence,
    confidenceBand: confidenceBand(confidence),
    userConfirmed: meal.userConfirmed,
    userEdited: meal.userEdited,
    isEstimate: true,
    createdAt: meal.createdAt.toISOString(),
    unresolved: items
      .filter((item) => item.source === 'unresolved')
      .map((item) => item.detectedName),
    notice: ESTIMATE_NOTICE,
  };
}
