import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDateSchema } from '../../lib/api-schemas.js';
import { addLocalDays, todayIn } from '../../lib/local-date.js';
import { bucket } from '../../middleware/rate-limit.js';
import { confidenceBand } from '../../nutrition/confidence.js';
import type { FoodRepository } from '../../nutrition/food-repository.js';
import type { FoodResolver } from '../../nutrition/food-resolver.js';
import { sumNutrients } from '../../nutrition/nutrition-calculator.js';
import type { NutritionProvider } from '../../nutrition/types.js';
import { MEAL_UNITS } from '../../nutrition/types.js';
import { requireUser } from '../auth/auth.plugin.js';
import { ESTIMATE_NOTICE } from '../meals/meals.schema.js';
import type { MealsRepository } from '../meals/meals.repository.js';
import type { UsersService } from '../users/users.service.js';

/**
 * `/api/nutrition` (API_DESIGN.md §9, NUTRITION_ARCHITECTURE.md §8).
 *
 * `/daily` deliberately leads with behaviour rather than calories, and omits the energy
 * block entirely when the user has asked not to see it.
 */

const foodSchema = z.object({
  foodId: z.string().uuid(),
  nameVi: z.string().nullable(),
  nameEn: z.string(),
  category: z.string().nullable(),
  provider: z.enum(['local', 'usda', 'off']),
  dataQuality: z.enum(['high', 'medium', 'low']),
  per100g: z.object({
    kcal: z.number().nullable(),
    proteinG: z.number().nullable(),
    carbsG: z.number().nullable(),
    fatG: z.number().nullable(),
    fiberG: z.number().nullable(),
  }),
  matchConfidence: z.number(),
  portions: z.array(
    z.object({
      id: z.string().uuid().nullable(),
      label: z.string(),
      labelVi: z.string().nullable(),
      grams: z.number(),
      isDefault: z.boolean(),
    }),
  ),
  /** How this row's figures were arrived at. Always present for local data. */
  sourceReference: z.string().nullable(),
});

const searchQuerySchema = z
  .object({ q: z.string().min(1).max(120), limit: z.coerce.number().int().min(1).max(25).default(10) })
  .strict();

const calculateSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            foodId: z.string().uuid().optional(),
            name: z.string().min(1).max(120).optional(),
            quantity: z.number().positive().max(100),
            unit: z.enum(MEAL_UNITS),
            sizeLabel: z.enum(['small', 'medium', 'large', 'custom']).optional(),
          })
          .strict()
          .refine((item) => item.foodId !== undefined || item.name !== undefined, {
            message: 'either foodId or name is required',
          }),
      )
      .min(1)
      .max(30),
  })
  .strict();

const nutrientsOutSchema = z.object({
  kcal: z.number().nullable().optional(),
  proteinG: z.number().nullable(),
  carbsG: z.number().nullable(),
  fatG: z.number().nullable(),
  fiberG: z.number().nullable(),
});

const dailyQuerySchema = z.object({ date: localDateSchema.optional() }).strict();

const periodQuerySchema = z
  .object({ from: localDateSchema.optional(), to: localDateSchema.optional() })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

export async function nutritionRoutes(
  app: FastifyInstance,
  options: {
    providers: readonly NutritionProvider[];
    foods: FoodRepository;
    resolver: FoodResolver;
    mealsRepository: MealsRepository;
    usersService: UsersService;
  },
): Promise<void> {
  const { providers, foods, resolver, mealsRepository, usersService } = options;

  const showCaloriesFor = async (userId: string): Promise<boolean> =>
    (await usersService.getProfile(userId)).preferences.showCalories;

  /**
   * Food search. One of only two unauthenticated endpoints in the API — food data is
   * public reference material, not user content (API_DESIGN.md §1).
   */
  app.get(
    '/search',
    {
      config: { rateLimit: bucket('nutrition') },
      schema: {
        querystring: searchQuerySchema,
        response: { 200: z.object({ data: z.array(foodSchema) }) },
      },
    },
    async (request) => {
      const { q, limit } = request.query as z.infer<typeof searchQuerySchema>;

      // Providers in priority order, first non-empty wins — local before USDA before OFF.
      const ordered = [...providers].sort((a, b) => a.priority - b.priority);
      for (const provider of ordered) {
        const hits = await provider.search(q, { limit });
        if (hits.length === 0) continue;

        const data = [];
        for (const hit of hits) {
          const row = await foods.findById(hit.foodId);
          data.push({
            foodId: hit.foodId,
            nameVi: hit.nameVi,
            nameEn: hit.nameEn,
            category: hit.category,
            provider: hit.provider,
            dataQuality: hit.dataQuality,
            per100g: hit.per100g,
            matchConfidence: hit.matchConfidence,
            portions: (await foods.portionsOf(hit.foodId)).map((portion) => ({
              id: portion.id ?? null,
              label: portion.label,
              labelVi: portion.labelVi ?? null,
              grams: portion.grams,
              isDefault: portion.isDefault ?? false,
            })),
            sourceReference: row?.sourceReference ?? null,
          });
        }
        return { data };
      }

      return { data: [] };
    },
  );

  /**
   * Resolve and calculate without persisting — what the log screen calls as the user
   * adjusts a portion. Same code path as saving a meal, so the preview cannot disagree
   * with what gets stored.
   */
  app.post(
    '/calculate',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('nutrition') },
      schema: {
        body: calculateSchema,
        response: {
          200: z.object({
            items: z.array(
              z.object({
                detectedName: z.string(),
                foodId: z.string().uuid().nullable(),
                displayNameVi: z.string().nullable(),
                gramsResolved: z.number().nullable(),
                nutrition: nutrientsOutSchema,
                source: z.string(),
                confidence: z.number(),
                confidenceBand: z.enum(['confident', 'estimate', 'uncertain', 'unresolved']),
                /** How grams and the food were arrived at — auditable, not a black box. */
                trace: z.string(),
              }),
            ),
            totals: nutrientsOutSchema,
            unresolved: z.array(z.string()),
            isEstimate: z.literal(true),
            notice: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof calculateSchema>;
      const showCalories = await showCaloriesFor(user.id);

      const resolved = [];
      for (const item of body.items) {
        resolved.push(
          await resolver.resolve(
            {
              name: item.name ?? '',
              quantity: item.quantity,
              unit: item.unit,
              ...(item.sizeLabel !== undefined ? { sizeLabel: item.sizeLabel } : {}),
              ...(item.foodId !== undefined ? { foodId: item.foodId } : {}),
            },
            user.id,
          ),
        );
      }

      const withCalories = <T extends { kcal: number | null }>(nutrients: T) => {
        const { kcal, ...rest } = nutrients;
        return showCalories ? { kcal, ...rest } : rest;
      };

      return {
        items: resolved.map((item) => ({
          detectedName: item.detectedName,
          foodId: item.foodId,
          displayNameVi: item.displayNameVi,
          gramsResolved: item.gramsResolved,
          nutrition: withCalories(item.nutrients),
          source: item.source,
          confidence: item.confidence,
          confidenceBand: confidenceBand(item.source === 'unresolved' ? null : item.confidence),
          trace: item.trace,
        })),
        totals: withCalories(sumNutrients(resolved.map((item) => item.nutrients))),
        unresolved: resolved
          .filter((item) => item.source === 'unresolved')
          .map((item) => item.detectedName),
        isEstimate: true as const,
        notice: ESTIMATE_NOTICE,
      };
    },
  );

  /**
   * The day's nutrition, **behaviour first** (NUTRITION_ARCHITECTURE.md §8).
   *
   * `focus` always comes first and is always present. `nutrition` is omitted entirely
   * when `showCalories` is false — the server does not send a number the user has asked
   * not to see. There is no goal, no deficit, no "remaining", and no streak penalty for
   * exceeding anything: the API vocabulary contains no concept of a calorie target.
   */
  app.get(
    '/daily',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: dailyQuerySchema,
        response: {
          200: z.object({
            localDate: z.string(),
            focus: z.object({
              mealsLogged: z.number().int(),
              distinctFoods: z.number().int(),
              itemsNeedingReview: z.number().int(),
            }),
            nutrition: z
              .object({
                kcal: z.number().nullable(),
                proteinG: z.number().nullable(),
                carbsG: z.number().nullable(),
                fatG: z.number().nullable(),
                fiberG: z.number().nullable(),
                isEstimate: z.literal(true),
                confidenceBand: z.enum(['confident', 'estimate', 'uncertain', 'unresolved']),
                /** True when an unresolved item means the total is missing something. */
                incomplete: z.boolean(),
              })
              .optional(),
            notice: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { date } = request.query as z.infer<typeof dailyQuerySchema>;
      const localDate = date ?? todayIn(user.timezone);

      const [day] = await mealsRepository.nutritionByDay(user.id, localDate, localDate);
      const showCalories = await showCaloriesFor(user.id);

      const focus = {
        mealsLogged: day?.mealsLogged ?? 0,
        distinctFoods: day?.distinctFoods ?? 0,
        itemsNeedingReview: day?.unresolvedItems ?? 0,
      };

      return {
        localDate,
        focus,
        ...(showCalories
          ? {
              nutrition: {
                kcal: day?.kcal ?? null,
                proteinG: day?.proteinG ?? null,
                carbsG: day?.carbsG ?? null,
                fatG: day?.fatG ?? null,
                fiberG: day?.fiberG ?? null,
                isEstimate: true as const,
                confidenceBand: confidenceBand(day?.minConfidence ?? null),
                incomplete: (day?.unresolvedItems ?? 0) > 0,
              },
            }
          : {}),
        notice: ESTIMATE_NOTICE,
      };
    },
  );

  /**
   * Weekly totals and averages — deterministic facts, no interpretation.
   *
   * Phase 4 reads these; it does not get to invent them. Averages are over **days
   * actually logged**, not over seven, because dividing by days the user did not log
   * would report a drop that describes the tracking rather than the eating.
   */
  app.get(
    '/weekly',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: periodQuerySchema,
        response: {
          200: z.object({
            period: z.object({ from: z.string(), to: z.string() }),
            daysLogged: z.number().int(),
            days: z.array(
              z.object({
                localDate: z.string(),
                mealsLogged: z.number().int(),
                nutrition: nutrientsOutSchema.optional(),
              }),
            ),
            totals: nutrientsOutSchema.optional(),
            averages: nutrientsOutSchema.optional(),
            isEstimate: z.literal(true),
            notice: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const query = request.query as z.infer<typeof periodQuerySchema>;

      const to = query.to ?? todayIn(user.timezone);
      const from = query.from ?? addLocalDays(to, -6);

      const days = await mealsRepository.nutritionByDay(user.id, from, to);
      const showCalories = await showCaloriesFor(user.id);

      const totals = sumNutrients(
        days.map((day) => ({
          kcal: day.kcal,
          proteinG: day.proteinG,
          carbsG: day.carbsG,
          fatG: day.fatG,
          fiberG: day.fiberG,
        })),
      );

      const divide = (value: number | null): number | null =>
        value === null || days.length === 0 ? null : Math.round((value / days.length) * 100) / 100;

      const strip = <T extends { kcal: number | null }>(nutrients: T) => {
        const { kcal, ...rest } = nutrients;
        return showCalories ? { kcal, ...rest } : rest;
      };

      return {
        period: { from, to },
        daysLogged: days.length,
        days: days.map((day) => ({
          localDate: day.localDate,
          mealsLogged: day.mealsLogged,
          nutrition: strip({
            kcal: day.kcal,
            proteinG: day.proteinG,
            carbsG: day.carbsG,
            fatG: day.fatG,
            fiberG: day.fiberG,
          }),
        })),
        totals: strip(totals),
        averages: strip({
          kcal: divide(totals.kcal),
          proteinG: divide(totals.proteinG),
          carbsG: divide(totals.carbsG),
          fatG: divide(totals.fatG),
          fiberG: divide(totals.fiberG),
        }),
        isEstimate: true as const,
        notice: ESTIMATE_NOTICE,
      };
    },
  );
}
