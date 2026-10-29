import { describe, expect, it, vi } from 'vitest';
import type { FoodRepository } from '../../src/nutrition/food-repository.js';
import { OpenFoodFactsProvider } from '../../src/nutrition/providers/open-food-facts-provider.js';
import { UsdaProvider } from '../../src/nutrition/providers/usda-provider.js';

/**
 * External provider failure handling (NUTRITION_ARCHITECTURE.md §7).
 *
 * The property under test throughout: **a provider failure is not an error**. Timeout,
 * rate limit, 500, malformed JSON — every one returns an empty result so the resolver
 * falls through to the next provider and finally to `unresolved`. Nutrition lookup never
 * blocks meal logging, and it never substitutes a fabricated number for a failed call.
 */

/** A repository stub: nothing is cached, and caching is a no-op we can observe. */
function stubRepository(): FoodRepository & { cached: unknown[] } {
  const cached: unknown[] = [];
  return {
    cached,
    searchFuzzy: vi.fn(async () => []),
    findById: vi.fn(async () => undefined),
    findByBarcode: vi.fn(async () => undefined),
    cacheExternalFood: vi.fn(async (record: unknown) => {
      cached.push(record);
      return {
        id: '00000000-0000-4000-8000-000000000001',
        canonicalName: 'x',
        nameVi: null,
        nameEn: 'x',
        provider: 'usda',
        dataQuality: 'high',
        kcalPer100g: '100',
        proteinPer100g: null,
        carbsPer100g: null,
        fatPer100g: null,
        fiberPer100g: null,
        category: null,
      } as never;
    }),
  } as unknown as FoodRepository & { cached: unknown[] };
}

const usdaConfig = { apiKey: 'test-key', baseUrl: 'https://api.example.test' };

describe('UsdaProvider — failure is not an error', () => {
  const failures: Array<[string, () => Promise<Response>]> = [
    ['a network error', () => Promise.reject(new Error('ECONNRESET'))],
    ['a timeout', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
    ['a rate limit', () => Promise.resolve(new Response('', { status: 429 }))],
    ['a server error', () => Promise.resolve(new Response('', { status: 500 }))],
    ['malformed JSON', () => Promise.resolve(new Response('not json', { status: 200 }))],
    [
      'a payload of the wrong shape',
      () => Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    ],
  ];

  for (const [name, fetchImpl] of failures) {
    it(`returns an empty result on ${name}`, async () => {
      const provider = new UsdaProvider(
        { ...usdaConfig, fetchImpl: fetchImpl as unknown as typeof fetch },
        stubRepository(),
      );
      await expect(provider.search('rice')).resolves.toEqual([]);
    });
  }

  it('parses a well-formed response and caches it', async () => {
    const repository = stubRepository();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          foods: [
            {
              fdcId: 169756,
              description: 'Rice, white, cooked',
              foodCategory: 'Cereal Grains',
              foodNutrients: [
                { nutrientId: 1008, value: 130 },
                { nutrientId: 1003, value: 2.7 },
                { nutrientId: 1005, value: 28.2 },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new UsdaProvider(
      { ...usdaConfig, fetchImpl: fetchImpl as unknown as typeof fetch },
      repository,
    );
    const results = await provider.search('rice');

    expect(results).toHaveLength(1);
    expect(repository.cached).toHaveLength(1);
    // Provenance names the exact record, so a figure can be traced back.
    expect(repository.cached[0]).toMatchObject({
      sourceReference: expect.stringContaining('169756'),
      per100g: expect.objectContaining({ kcal: 130 }),
    });
  });

  it('skips a food with no energy value rather than storing a hole', async () => {
    const repository = stubRepository();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          foods: [{ fdcId: 1, description: 'Mystery', foodNutrients: [{ nutrientId: 1003, value: 5 }] }],
        }),
        { status: 200 },
      ),
    );

    const provider = new UsdaProvider(
      { ...usdaConfig, fetchImpl: fetchImpl as unknown as typeof fetch },
      repository,
    );
    expect(await provider.search('mystery')).toEqual([]);
    expect(repository.cached).toEqual([]);
  });

  it('sends the API key as a header, never in the query string', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ foods: [] }), { status: 200 }));
    const provider = new UsdaProvider(
      { ...usdaConfig, fetchImpl: fetchImpl as unknown as typeof fetch },
      stubRepository(),
    );
    await provider.search('rice');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // A key in a URL ends up in access logs and referrers.
    expect(url).not.toContain('test-key');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('test-key');
  });
});

describe('OpenFoodFactsProvider', () => {
  const config = { baseUrl: 'https://off.example.test', userAgent: 'AURA/1.0 (test)' };

  it('refuses to construct without a User-Agent, rather than 403ing on every call', () => {
    expect(
      () => new OpenFoodFactsProvider({ ...config, userAgent: '' }, stubRepository()),
    ).toThrow(/User-Agent/);
  });

  it('sends the User-Agent, because OFF blocks anonymous clients', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ products: [] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider(
      { ...config, fetchImpl: fetchImpl as unknown as typeof fetch },
      stubRepository(),
    );
    await provider.search('milk');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('AURA/1.0 (test)');
  });

  it('returns null for an unknown barcode instead of a guess', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 0 }), { status: 200 }));
    const provider = new OpenFoodFactsProvider(
      { ...config, fetchImpl: fetchImpl as unknown as typeof fetch },
      stubRepository(),
    );
    await expect(provider.getByBarcode('0000000000000')).resolves.toBeNull();
  });

  it('survives a network failure on a barcode lookup', async () => {
    const provider = new OpenFoodFactsProvider(
      { ...config, fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch },
      stubRepository(),
    );
    await expect(provider.getByBarcode('123')).resolves.toBeNull();
  });

  it('is marked low quality, because the data is crowd-sourced', () => {
    const provider = new OpenFoodFactsProvider(config, stubRepository());
    expect(provider.dataQuality).toBe('low');
    // And it sits behind local and USDA in the chain.
    expect(provider.priority).toBe(3);
  });
});

describe('provider priority', () => {
  it('orders local first, then USDA, then Open Food Facts', () => {
    const usda = new UsdaProvider(usdaConfig, stubRepository());
    const off = new OpenFoodFactsProvider(
      { baseUrl: 'https://off.example.test', userAgent: 'AURA/1.0 (test)' },
      stubRepository(),
    );

    // Local is 1 — the only source that knows what cá kho tộ is.
    expect(usda.priority).toBeGreaterThan(1);
    expect(off.priority).toBeGreaterThan(usda.priority);
  });
});

describe('external hits must name the query (regression: milk resolved to cottage cheese)', () => {
  const cottageCheese = {
    fdcId: 173417,
    description: 'Cheese, cottage, lowfat, 1% milkfat',
    foodCategory: 'Dairy and Egg Products',
    foodNutrients: [{ nutrientId: 1008, value: 72 }],
  };

  it('neither offers nor caches a USDA hit that shares only a number with the phrase', async () => {
    const repository = stubRepository();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ foods: [cottageCheese] }), { status: 200 }));
    const provider = new UsdaProvider({ ...usdaConfig, fetchImpl: fetchImpl as unknown as typeof fetch }, repository);

    expect(await provider.search('uống 1 hộp sữa ít đường')).toEqual([]);
    expect(await provider.search('sữa ít đường')).toEqual([]);
    // Not cached either, so a later search cannot find it in `foods` and serve it then.
    expect(repository.cached).toEqual([]);
  });

  it('ignores a cached USDA row that does not name the query', async () => {
    const repository = stubRepository();
    (repository.searchFuzzy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { row: { id: 'cached-1', canonicalName: cottageCheese.description, nameEn: cottageCheese.description, nameVi: null }, similarity: 0.5 },
    ]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ foods: [] }), { status: 200 }));
    const provider = new UsdaProvider({ ...usdaConfig, fetchImpl: fetchImpl as unknown as typeof fetch }, repository);

    expect(await provider.search('sữa ít đường')).toEqual([]);
  });

  it('still accepts a USDA hit that names the query', async () => {
    const repository = stubRepository();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          foods: [{ fdcId: 171287, description: 'Egg, whole, raw, fresh', foodNutrients: [{ nutrientId: 1008, value: 143 }] }],
        }),
        { status: 200 },
      ),
    );
    const provider = new UsdaProvider({ ...usdaConfig, fetchImpl: fetchImpl as unknown as typeof fetch }, repository);

    expect(await provider.search('eggs')).toHaveLength(1);
  });

  it('applies the same check to Open Food Facts', async () => {
    const repository = stubRepository();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          products: [
            { code: '1', product_name: 'Cottage cheese 1%', nutriments: { 'energy-kcal_100g': 72 } },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenFoodFactsProvider(
      { baseUrl: 'https://off.example.test', userAgent: 'AURA-test/1.0', fetchImpl: fetchImpl as unknown as typeof fetch },
      repository,
    );

    expect(await provider.search('sữa ít đường')).toEqual([]);
    expect(repository.cached).toEqual([]);

    // The same response shape is accepted when the product does name the phrase, so the
    // rejection above is the relevance check and not a payload the schema refused.
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          products: [
            { code: '2', product_name: 'Sữa tươi ít đường', nutriments: { 'energy-kcal_100g': 70 } },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await provider.search('sữa ít đường')).toHaveLength(1);
  });
});
