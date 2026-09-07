import { z } from 'zod';
import type { FoodRepository } from '../food-repository.js';
import { toCandidate } from '../food-repository.js';
import type { FoodCandidate, NutritionProvider, SearchOptions } from '../types.js';

/**
 * USDA FoodData Central — authoritative for generic whole foods and ingredients
 * (NUTRITION_ARCHITECTURE.md §2).
 *
 * Two things make this safe to depend on without depending on it:
 *
 * - **Everything is cached into `foods` on first use** (§7), so a repeated Vietnamese
 *   meal resolves without a network call after day one.
 * - **A failure is not an error.** Timeout, rate limit, malformed payload — all return an
 *   empty result so the resolver falls through to the next provider and finally to
 *   `unresolved`. Nutrition lookup never blocks meal logging.
 *
 * The response is parsed with Zod rather than trusted: an external API is input, the same
 * way a model response is.
 */

/** USDA nutrient numbers are stable identifiers; the names in the payload are not. */
const NUTRIENT_IDS = {
  kcal: 1008,
  proteinG: 1003,
  carbsG: 1005,
  fatG: 1004,
  fiberG: 1079,
} as const;

const searchResponseSchema = z.object({
  foods: z
    .array(
      z.object({
        fdcId: z.number(),
        description: z.string(),
        foodCategory: z.string().optional(),
        foodNutrients: z
          .array(
            z.object({
              nutrientId: z.number(),
              value: z.number().nullable().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export interface UsdaProviderConfig {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class UsdaProvider implements NutritionProvider {
  readonly name = 'usda' as const;
  readonly priority = 2;
  readonly dataQuality = 'high' as const;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: UsdaProviderConfig,
    private readonly repository: FoodRepository,
  ) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 4_000;
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodCandidate[]> {
    const limit = options.limit ?? 5;

    // Serve a previous lookup for the same term without touching the network.
    const cached = await this.repository.searchFuzzy(query, { limit, provider: 'usda' });
    if (cached.length > 0) {
      return cached.map(({ row, similarity }) =>
        toCandidate(row, clampExternal(similarity), 'cached'),
      );
    }

    const payload = await this.request(query, limit);
    if (!payload) return [];

    const candidates: FoodCandidate[] = [];
    for (const item of payload.foods.slice(0, limit)) {
      const per100g = {
        kcal: nutrientOf(item.foodNutrients, NUTRIENT_IDS.kcal),
        proteinG: nutrientOf(item.foodNutrients, NUTRIENT_IDS.proteinG),
        carbsG: nutrientOf(item.foodNutrients, NUTRIENT_IDS.carbsG),
        fatG: nutrientOf(item.foodNutrients, NUTRIENT_IDS.fatG),
        fiberG: nutrientOf(item.foodNutrients, NUTRIENT_IDS.fiberG),
      };

      // A row with no energy value is not worth caching or offering.
      if (per100g.kcal === null) continue;

      const row = await this.repository.cacheExternalFood({
        provider: 'usda',
        externalId: String(item.fdcId),
        canonicalName: item.description,
        nameEn: item.description,
        category: item.foodCategory ?? null,
        per100g,
        dataQuality: 'high',
        sourceReference: `USDA FoodData Central, FDC ID ${item.fdcId}`,
      });

      // §4 step 5: a USDA search hit sits between 0.60 and 0.80 — it matched a text query
      // in a foreign-language corpus, which is weaker evidence than a local exact match.
      candidates.push(toCandidate(row, 0.7, 'usda'));
    }

    return candidates;
  }

  async getById(foodId: string): Promise<FoodCandidate | null> {
    const row = await this.repository.findById(foodId);
    if (!row || row.provider !== 'usda') return null;
    return toCandidate(row, 1, 'cached');
  }

  private async request(query: string, limit: number): Promise<z.infer<typeof searchResponseSchema> | null> {
    const url = new URL('/fdc/v1/foods/search', this.config.baseUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('pageSize', String(limit));
    url.searchParams.set('dataType', 'Foundation,SR Legacy');

    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { 'X-Api-Key': this.config.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // 429 and 5xx are expected outcomes, not exceptions: fall through quietly.
      if (!response.ok) return null;

      const parsed = searchResponseSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      // Timeout, DNS, connection reset, malformed JSON. All the same answer: no data.
      return null;
    }
  }
}

function nutrientOf(
  nutrients: ReadonlyArray<{ nutrientId: number; value?: number | null | undefined }>,
  id: number,
): number | null {
  const found = nutrients.find((nutrient) => nutrient.nutrientId === id);
  return found?.value ?? null;
}

function clampExternal(score: number): number {
  return Math.round(Math.min(0.85, Math.max(0.6, score)) * 1000) / 1000;
}
