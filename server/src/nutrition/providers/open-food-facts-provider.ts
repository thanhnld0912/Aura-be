import { z } from 'zod';
import type { FoodRepository } from '../food-repository.js';
import { toCandidate } from '../food-repository.js';
import type { FoodCandidate, NutritionProvider, SearchOptions } from '../types.js';

/**
 * Open Food Facts — packaged goods, drinks, snacks, and the only provider with barcode
 * coverage (NUTRITION_ARCHITECTURE.md §2).
 *
 * `dataQuality` is `low` and that is not a slight: OFF is crowd-sourced, so a given
 * product's figures may be transcribed from a label by anyone. Good enough to offer,
 * honest enough to mark, and §6 discounts item confidence accordingly.
 *
 * The `User-Agent` is **not optional** — OFF blocks anonymous clients (§7) — which is why
 * the provider refuses to construct without one rather than failing every request at
 * runtime with an opaque 403.
 */

const productSchema = z.object({
  code: z.string().optional(),
  product_name: z.string().optional(),
  product_name_vi: z.string().optional(),
  categories: z.string().optional(),
  nutriments: z
    .object({
      'energy-kcal_100g': z.number().optional(),
      proteins_100g: z.number().optional(),
      carbohydrates_100g: z.number().optional(),
      fat_100g: z.number().optional(),
      fiber_100g: z.number().optional(),
    })
    .default({}),
});

const barcodeResponseSchema = z.object({
  status: z.number(),
  product: productSchema.optional(),
});

const searchResponseSchema = z.object({
  products: z.array(productSchema).default([]),
});

export interface OpenFoodFactsConfig {
  baseUrl: string;
  /** Required: OFF blocks anonymous clients. */
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenFoodFactsProvider implements NutritionProvider {
  readonly name = 'off' as const;
  readonly priority = 3;
  readonly dataQuality = 'low' as const;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: OpenFoodFactsConfig,
    private readonly repository: FoodRepository,
  ) {
    if (!config.userAgent || config.userAgent.trim().length === 0) {
      throw new Error(
        'OpenFoodFactsProvider needs a descriptive User-Agent — OFF blocks anonymous clients',
      );
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 4_000;
  }

  async search(query: string, options: SearchOptions = {}): Promise<FoodCandidate[]> {
    const limit = options.limit ?? 5;

    const cached = await this.repository.searchFuzzy(query, { limit, provider: 'off' });
    if (cached.length > 0) {
      return cached.map(({ row }) => toCandidate(row, 0.6, 'cached'));
    }

    const url = new URL('/cgi/search.pl', this.config.baseUrl);
    url.searchParams.set('search_terms', query);
    url.searchParams.set('json', '1');
    url.searchParams.set('page_size', String(limit));

    const payload = await this.request(url, searchResponseSchema);
    if (!payload) return [];

    const candidates: FoodCandidate[] = [];
    for (const product of payload.products.slice(0, limit)) {
      const candidate = await this.cache(product);
      // §4 step 6: an OFF search hit sits between 0.50 and 0.70.
      if (candidate) candidates.push({ ...candidate, matchConfidence: 0.6, matchedBy: 'off' });
    }
    return candidates;
  }

  /**
   * The reason this provider exists. A barcode is an exact identifier, so a hit here is
   * far stronger evidence than a text search — the *identification* is certain even
   * though the underlying figures are crowd-sourced.
   */
  async getByBarcode(barcode: string): Promise<FoodCandidate | null> {
    const cached = await this.repository.findByBarcode(barcode);
    if (cached) return toCandidate(cached, 0.95, 'cached');

    const url = new URL(`/api/v2/product/${encodeURIComponent(barcode)}.json`, this.config.baseUrl);
    const payload = await this.request(url, barcodeResponseSchema);
    if (!payload || payload.status !== 1 || !payload.product) return null;

    const candidate = await this.cache({ ...payload.product, code: barcode });
    return candidate ? { ...candidate, matchConfidence: 0.95, matchedBy: 'off' } : null;
  }

  async getById(foodId: string): Promise<FoodCandidate | null> {
    const row = await this.repository.findById(foodId);
    if (!row || row.provider !== 'off') return null;
    return toCandidate(row, 1, 'cached');
  }

  private async cache(product: z.infer<typeof productSchema>): Promise<FoodCandidate | null> {
    const name = product.product_name_vi ?? product.product_name;
    const kcal = product.nutriments['energy-kcal_100g'];
    // No name or no energy value means there is nothing worth offering the user.
    if (!name || kcal === undefined || !product.code) return null;

    const row = await this.repository.cacheExternalFood({
      provider: 'off',
      externalId: product.code,
      canonicalName: name,
      nameEn: product.product_name ?? name,
      nameVi: product.product_name_vi ?? null,
      category: product.categories?.split(',')[0]?.trim() ?? null,
      barcode: product.code,
      per100g: {
        kcal,
        proteinG: product.nutriments.proteins_100g ?? null,
        carbsG: product.nutriments.carbohydrates_100g ?? null,
        fatG: product.nutriments.fat_100g ?? null,
        fiberG: product.nutriments.fiber_100g ?? null,
      },
      dataQuality: 'low',
      sourceReference: `Open Food Facts, product ${product.code}; crowd-sourced label data`,
    });

    return toCandidate(row, 0.6, 'off');
  }

  private async request<T extends z.ZodTypeAny>(url: URL, schema: T): Promise<z.infer<T> | null> {
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { 'User-Agent': this.config.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;

      const parsed = schema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
