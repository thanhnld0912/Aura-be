import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFoods } from '../../src/database/seeds/seed-foods.js';
import type { MealParser } from '../../src/nutrition/parser/meal-parser.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * Food identification through every path that resolves a name, against a real database
 * and the real Vietnamese dataset.
 *
 * The regression this guards: "thịt gà" resolved to *thịt bò*, because character trigrams
 * let the generic word "thịt" outvote the word that named the food, and "bò" resolved to
 * *bơ* (avocado) as an exact match, because diacritics were compared only after being
 * stripped. `tests/unit/food-match.test.ts` covers the ranking rules; this file proves
 * each consumer — search, calculation, parsing, confirmation, quick-add — inherits them.
 */

const words = (name: unknown) =>
  typeof name === 'string' ? name.normalize('NFC').toLowerCase().split(/\s+/) : [];
const isChicken = (name: unknown) => words(name).includes('gà');
const isBeef = (name: unknown) => words(name).includes('bò');

/** Stands in for Claude or the vision model: what it read is fixed, the resolver is real. */
class ScriptedParser implements MealParser {
  readonly name = 'scripted-model';
  async parse(): ReturnType<MealParser['parse']> {
    return {
      items: [
        { name: 'thịt gà', quantity: 100, unit: 'g', confidence: 0.9 },
        { name: 'bò', quantity: 100, unit: 'g', confidence: 0.9 },
      ],
      ambiguous: [],
      parser: this.name,
    };
  }
}

describe.skipIf(!hasDatabase)('food resolution', () => {
  let harness: DatabaseHarness;
  let token: string;
  const userId = testUserId('a');

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    token = await signTestToken({ sub: userId, email: 'thanh@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await seedFoods(harness.database.db);
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
  });

  const search = async (q: string) =>
    (await harness.app.inject({ method: 'GET', url: `/api/nutrition/search?q=${encodeURIComponent(q)}` })).json()
      .data as Array<{ foodId: string; nameVi: string | null; matchConfidence: number }>;

  const calculate = async (names: string[]) => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/nutrition/calculate',
      headers: bearer(token),
      payload: { items: names.map((name) => ({ name, quantity: 100, unit: 'g' })) },
    });
    expect(response.statusCode).toBe(200);
    return response.json().items as Array<{
      detectedName: string;
      displayNameVi: string | null;
      source: string;
      confidenceBand: string;
      nutrition: { kcal: number | null };
    }>;
  };

  describe('search', () => {
    it.each(['thịt gà', 'thit ga'])('lists only chicken for %s, chicken first', async (query) => {
      const hits = await search(query);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => isChicken(hit.nameVi)), JSON.stringify(hits.map((h) => h.nameVi))).toBe(true);
    });

    it('puts beef first for "bò" and the avocado first for "bơ"', async () => {
      expect((await search('bò'))[0]?.nameVi).toBe('Thịt bò');
      expect((await search('bơ'))[0]?.nameVi).toBe('Bơ');
    });

    it('keeps the staples where they were', async () => {
      expect((await search('cơm'))[0]?.nameVi).toBe('Cơm trắng');
      expect((await search('com trang'))[0]?.nameVi).toBe('Cơm trắng');
      expect((await search('phở'))[0]?.nameVi).toBe('Phở bò');
      expect((await search('trứng'))[0]?.nameVi).toBe('Trứng luộc');
    });
  });

  describe('calculation', () => {
    it('resolves chicken, beef, rice and egg names to the right food family', async () => {
      const items = await calculate([
        'thịt gà', 'thit ga', 'gà', 'ga', 'ức gà', 'uc ga', 'gà luộc', 'ga luoc',
        'thịt bò', 'thit bo', 'bò', 'bo',
        'cơm trắng', 'com trang', 'trứng', 'trung', 'trứng luộc', 'trung luoc',
      ]);
      const byName = new Map(items.map((item) => [item.detectedName, item]));

      for (const name of ['thịt gà', 'thit ga', 'gà', 'ga', 'ức gà', 'uc ga', 'gà luộc', 'ga luoc']) {
        expect(isChicken(byName.get(name)?.displayNameVi), `${name} → ${byName.get(name)?.displayNameVi}`).toBe(true);
      }
      for (const name of ['thịt bò', 'thit bo', 'bò', 'bo']) {
        expect(isBeef(byName.get(name)?.displayNameVi), `${name} → ${byName.get(name)?.displayNameVi}`).toBe(true);
      }
      for (const name of ['cơm trắng', 'com trang']) expect(byName.get(name)?.displayNameVi).toBe('Cơm trắng');
      for (const name of ['trứng luộc', 'trung luoc']) expect(byName.get(name)?.displayNameVi).toBe('Trứng luộc');
      for (const name of ['trứng', 'trung']) expect(words(byName.get(name)?.displayNameVi)).toContain('trứng');
      // Every one of them is a local food with a real figure, not an unresolved gap.
      for (const item of items) expect(item.source, item.detectedName).toBe('local');
    });

    it('does not present a default among many as confident', async () => {
      const items = await calculate(['thịt gà', 'gà', 'bo', 'cơm', 'trứng', 'thịt']);
      for (const item of items) expect(item.confidenceBand, item.detectedName).toBe('estimate');
    });

    it('keeps an exact name confident', async () => {
      const items = await calculate(['cơm trắng', 'thịt bò', 'trứng luộc']);
      for (const item of items) expect(item.confidenceBand, item.detectedName).toBe('confident');
    });

    it('takes the figures from the dataset, not from the name', async () => {
      // Ức gà luộc is 165 kcal per 100 g in the seed; beef would have been 250.
      const [chicken] = await calculate(['thịt gà']);
      expect(chicken?.displayNameVi).toBe('Ức gà luộc');
      expect(chicken?.nutrition.kcal).toBe(165);
    });
  });

  describe('describe mode, rule-based parser', () => {
    it('drafts "100g thịt gà" as chicken, then confirms it into one event', async () => {
      const parsed = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(token),
        payload: { text: '100g thịt gà, 1 bát cơm trắng', mealType: 'lunch' },
      });
      expect(parsed.statusCode).toBe(200);
      const meal = parsed.json().meal;
      expect(meal.status).toBe('draft');
      expect(meal.unresolved).toEqual([]);
      const names = meal.items.map((item: { displayNameVi: string }) => item.displayNameVi);
      expect(names.some(isChicken)).toBe(true);
      expect(names.some(isBeef)).toBe(false);
      expect(names).toContain('Cơm trắng');

      const confirmed = await harness.app.inject({
        method: 'POST',
        url: `/api/meals/${meal.id}/confirm`,
        headers: bearer(token),
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().status).toBe('confirmed');

      const events = await harness.app.inject({ method: 'GET', url: '/api/events/today', headers: bearer(token) });
      expect(events.json().data).toHaveLength(1);
    });
  });

  describe('quick add', () => {
    it('logs the chicken the search offered, by id', async () => {
      const [first] = await search('thịt gà');
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'dinner', items: [{ foodId: first?.foodId, quantity: 100, unit: 'g' }] },
      });
      expect(created.statusCode).toBe(201);
      expect(isChicken(created.json().items[0].displayNameVi)).toBe(true);
    });
  });
});

describe.skipIf(!hasDatabase)('food resolution behind a model parser', () => {
  let harness: DatabaseHarness;
  let token: string;

  beforeAll(async () => {
    harness = await createDatabaseHarness({ mealParser: new ScriptedParser() });
    token = await signTestToken({ sub: testUserId('a'), email: 'thanh@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    await seedFoods(harness.database.db);
    await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
  });

  it('resolves what the model read through the same rules', async () => {
    const parsed = await harness.app.inject({
      method: 'POST',
      url: '/api/meals/parse',
      headers: bearer(token),
      payload: { text: 'thịt gà và bò', mealType: 'dinner' },
    });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json().parser).toBe('scripted-model');

    const [chicken, beef] = parsed.json().meal.items as Array<{ displayNameVi: string; confidenceBand: string }>;
    expect(isChicken(chicken?.displayNameVi)).toBe(true);
    expect(beef?.displayNameVi).toBe('Thịt bò');
    // A model's reading of a bare word is still a default among many: never confident.
    expect(chicken?.confidenceBand).toBe('estimate');
  });
});
