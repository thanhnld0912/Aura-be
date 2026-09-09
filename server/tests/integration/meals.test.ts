import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFoods } from '../../src/database/seeds/seed-foods.js';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * Meal logging end to end, against a real database and the real Vietnamese dataset.
 *
 * The assertions that matter are the ones about what the server *refuses* to do: trust a
 * client's calorie count, invent a number for a food it does not know, or send an energy
 * value to a user who asked not to see one.
 */
describe.skipIf(!hasDatabase)('meals', () => {
  let harness: DatabaseHarness;
  let token: string;
  let tokenB: string;
  const userId = testUserId('a');
  const userBId = testUserId('b');

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    token = await signTestToken({ sub: userId, email: 'thanh@example.com' });
    tokenB = await signTestToken({ sub: userBId, email: 'b@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    // The dataset is reference data, so it is reloaded after the truncate.
    await seedFoods(harness.database.db);
    for (const t of [token, tokenB]) {
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(t) });
    }
  });

  const search = (q: string) =>
    harness.app.inject({ method: 'GET', url: `/api/nutrition/search?q=${encodeURIComponent(q)}` });

  const findFood = async (q: string): Promise<{ foodId: string; portions: Array<{ id: string; labelVi: string | null; grams: number }> }> => {
    const response = await search(q);
    const first = response.json().data[0];
    return { foodId: first.foodId, portions: first.portions };
  };

  describe('food search', () => {
    it('finds a Vietnamese dish without diacritics', async () => {
      const response = await search('thit kho trung');
      expect(response.statusCode).toBe(200);
      expect(response.json().data[0].nameVi).toBe('Thịt kho trứng');
    });

    it('finds the same dish with diacritics and in upper case', async () => {
      for (const query of ['thịt kho trứng', 'THỊT KHO TRỨNG']) {
        const response = await search(query);
        expect(response.json().data[0].nameVi, query).toBe('Thịt kho trứng');
      }
    });

    it('prefers the plain staple for an ambiguous bare term', async () => {
      // "cơm" matches cơm trắng, cơm gà and cơm tấm equally well on trigrams; without a
      // curated preference the shortest name wins and "rice" means chicken rice.
      expect((await search('cơm')).json().data[0].nameVi).toBe('Cơm trắng');
      expect((await search('phở')).json().data[0].nameVi).toBe('Phở bò');
    });

    it('searches the English name too', async () => {
      expect((await search('white rice')).json().data[0].nameVi).toBe('Cơm trắng');
    });

    it('returns provenance and household portions with every hit', async () => {
      const food = (await search('cơm trắng')).json().data[0];
      expect(food.sourceReference).toContain('USDA');
      expect(food.dataQuality).toBe('high');
      expect(food.portions.map((p: { labelVi: string }) => p.labelVi)).toContain('1 chén');
    });

    it('returns nothing rather than a wrong food for gibberish', async () => {
      expect((await search('zzzqqq khong co mon nay')).json().data).toEqual([]);
    });

    it('needs no authentication — food data is public reference material', async () => {
      expect((await search('cơm')).statusCode).toBe(200);
    });
  });

  describe('deterministic calculation', () => {
    it('resolves 2 chén of rice to 300 g and 390 kcal', async () => {
      const { foodId } = await findFood('cơm trắng');

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/nutrition/calculate',
        headers: bearer(token),
        payload: { items: [{ foodId, quantity: 2, unit: 'bowl' }] },
      });

      expect(response.statusCode).toBe(200);
      const item = response.json().items[0];
      expect(item.gramsResolved).toBe(300);
      expect(item.nutrition.kcal).toBe(390);
      expect(response.json().isEstimate).toBe(true);
      // The trace says how, so a surprising number can be audited rather than argued with.
      expect(item.trace).toContain('1 chén');
    });

    it('gives an unknown food no number at all', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/nutrition/calculate',
        headers: bearer(token),
        payload: { items: [{ name: 'mon an khong ton tai zzz', quantity: 1, unit: 'serving' }] },
      });

      const item = response.json().items[0];
      expect(item.source).toBe('unresolved');
      expect(item.nutrition.kcal).toBeNull();
      expect(item.confidenceBand).toBe('unresolved');
      expect(response.json().unresolved).toEqual(['mon an khong ton tai zzz']);
      // And the meal total is unknown rather than the sum of what happened to resolve.
      expect(response.json().totals.kcal).toBeNull();
    });

    it('rejects a zero or negative quantity', async () => {
      for (const quantity of [0, -1]) {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/nutrition/calculate',
          headers: bearer(token),
          payload: { items: [{ name: 'cơm', quantity, unit: 'bowl' }] },
        });
        expect(response.statusCode, String(quantity)).toBe(400);
      }
    });
  });

  describe('manual meal logging', () => {
    it('creates a confirmed meal with a timeline event', async () => {
      const { foodId } = await findFood('cơm trắng');

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 2, unit: 'bowl' }] },
      });

      expect(response.statusCode).toBe(201);
      const meal = response.json();
      expect(meal.status).toBe('confirmed');
      expect(meal.eventId).not.toBeNull();
      expect(meal.totals.kcal).toBe(390);
      expect(meal.isEstimate).toBe(true);

      // The Phase 2 invariant: a confirmed meal has an event.
      const events = await harness.sql`select type from daily_events where id = ${meal.eventId}`;
      expect(events[0]?.['type']).toBe('meal');
    });

    it('ignores a calorie count the client tries to supply', async () => {
      const { foodId } = await findFood('cơm trắng');

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: {
          mealType: 'lunch',
          items: [{ foodId, quantity: 1, unit: 'bowl', kcal: 5, calories: 5 }],
        },
      });

      // Not silently ignored — rejected. Unknown keys are a 400 (SECURITY.md §3), so a
      // client cannot even attempt to assert nutrition.
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('keeps a draft off the timeline until it is confirmed', async () => {
      const { foodId } = await findFood('cơm trắng');

      const draft = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', status: 'draft', items: [{ foodId, quantity: 1, unit: 'bowl' }] },
      });

      expect(draft.statusCode).toBe(201);
      expect(draft.json().status).toBe('draft');
      expect(draft.json().eventId).toBeNull();

      const events = await harness.sql`select count(*)::int as c from daily_events`;
      expect(events[0]?.['c']).toBe(0);

      const confirmed = await harness.app.inject({
        method: 'POST',
        url: `/api/meals/${draft.json().id}/confirm`,
        headers: bearer(token),
      });

      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().status).toBe('confirmed');
      expect(confirmed.json().eventId).not.toBeNull();
      expect(confirmed.json().userConfirmed).toBe(true);
    });

    it('refuses to confirm the same meal twice', async () => {
      const { foodId } = await findFood('cơm trắng');
      const draft = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', status: 'draft', items: [{ foodId, quantity: 1, unit: 'bowl' }] },
      });

      await harness.app.inject({
        method: 'POST',
        url: `/api/meals/${draft.json().id}/confirm`,
        headers: bearer(token),
      });
      const again = await harness.app.inject({
        method: 'POST',
        url: `/api/meals/${draft.json().id}/confirm`,
        headers: bearer(token),
      });

      expect(again.statusCode).toBe(409);
    });

    it('stores a nutrition snapshot that a later food change cannot rewrite', async () => {
      const { foodId } = await findFood('cơm trắng');
      const meal = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 1, unit: 'bowl' }] },
      });

      // The food's figures are revised — as USDA or our own dataset might revise them.
      await harness.sql`update foods set kcal_per_100g = 999 where id = ${foodId}`;

      const reread = await harness.app.inject({
        method: 'GET',
        url: `/api/meals/${meal.json().id}`,
        headers: bearer(token),
      });

      // History keeps the number the user actually saw and confirmed.
      expect(reread.json().totals.kcal).toBe(195);
    });

    it('soft-deletes a meal and removes it from the day', async () => {
      const { foodId } = await findFood('cơm trắng');
      const meal = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 1, unit: 'bowl' }] },
      });

      const deleted = await harness.app.inject({
        method: 'DELETE',
        url: `/api/meals/${meal.json().id}`,
        headers: bearer(token),
      });
      expect(deleted.statusCode).toBe(204);

      const today = await harness.app.inject({
        method: 'GET',
        url: '/api/meals/today',
        headers: bearer(token),
      });
      expect(today.json().data).toEqual([]);

      // Soft, not hard: the row survives for history.
      const rows = await harness.sql`select deleted_at from meals where id = ${meal.json().id}`;
      expect(rows[0]?.['deleted_at']).not.toBeNull();
    });
  });

  describe('natural language parsing', () => {
    it('parses the documented Vietnamese example into a reviewable draft', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(token),
        payload: { text: 'Tôi ăn 2 chén cơm với thịt kho trứng và canh rau.', mealType: 'lunch' },
      });

      expect(response.statusCode).toBe(200);
      const meal = response.json().meal;

      // A draft, never straight to logged data — parsing is the least certain step.
      expect(meal.status).toBe('draft');
      expect(meal.eventId).toBeNull();
      expect(meal.items).toHaveLength(3);

      const names = meal.items.map((item: { displayNameVi: string }) => item.displayNameVi);
      expect(names).toContain('Cơm trắng');
      expect(names).toContain('Thịt kho trứng');

      // 2 chén of rice is 300 g, which is 390 kcal — from the database, not the parser.
      const rice = meal.items.find((item: { displayNameVi: string }) => item.displayNameVi === 'Cơm trắng');
      expect(rice.gramsResolved).toBe(300);
      expect(rice.nutrition.kcal).toBe(390);
    });

    it('reports which parser produced the reading', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(token),
        payload: { text: '1 tô phở bò', mealType: 'breakfast' },
      });
      expect(response.json().parser).toBe('rule-based-v1');
    });

    it('marks an unrecognised food unresolved rather than guessing', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(token),
        payload: { text: '1 phần zzzqqq khong co that', mealType: 'lunch' },
      });

      const meal = response.json().meal;
      expect(meal.unresolved.length).toBeGreaterThan(0);
      expect(meal.items[0].nutrition.kcal).toBeNull();
      expect(meal.totals.kcal).toBeNull();
    });

    it('rejects text with no readable food', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(token),
        payload: { text: '...', mealType: 'lunch' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('user correction and the alias loop', () => {
    it('pins a corrected meal to full confidence and remembers the correction', async () => {
      const parsed = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(token),
        payload: { text: '1 phần com me nau', mealType: 'dinner' },
      });

      const mealId = parsed.json().meal.id;
      const { foodId } = await findFood('cơm trắng');

      const corrected = await harness.app.inject({
        method: 'PATCH',
        url: `/api/meals/${mealId}`,
        headers: bearer(token),
        payload: { items: [{ foodId, quantity: 1, unit: 'bowl' }] },
      });

      expect(corrected.statusCode).toBe(200);
      expect(corrected.json().items[0].confidence).toBe(1);
      expect(corrected.json().userEdited).toBe(true);

      // The correction is remembered, scoped to this user.
      const aliases = await harness.sql`
        select alias_normalized, food_id, user_id from user_food_aliases`;
      expect(aliases).toHaveLength(1);
      expect(aliases[0]?.['alias_normalized']).toBe('com me nau');
      expect(aliases[0]?.['user_id']).toBe(userId);

      // And it resolves at full confidence next time.
      const again = await harness.app.inject({
        method: 'POST',
        url: '/api/nutrition/calculate',
        headers: bearer(token),
        payload: { items: [{ name: 'com me nau', quantity: 1, unit: 'bowl' }] },
      });
      expect(again.json().items[0].displayNameVi).toBe('Cơm trắng');
      expect(again.json().items[0].confidenceBand).toBe('confident');
    });

    it('does not apply one user alias to another', async () => {
      const { foodId } = await findFood('cơm trắng');
      const parsed = await harness.app.inject({
        method: 'POST',
        url: '/api/meals/parse',
        headers: bearer(token),
        payload: { text: '1 phần com me nau', mealType: 'dinner' },
      });
      await harness.app.inject({
        method: 'PATCH',
        url: `/api/meals/${parsed.json().meal.id}`,
        headers: bearer(token),
        payload: { items: [{ foodId, quantity: 1, unit: 'bowl' }] },
      });

      const forB = await harness.app.inject({
        method: 'POST',
        url: '/api/nutrition/calculate',
        headers: bearer(tokenB),
        payload: { items: [{ name: 'com me nau', quantity: 1, unit: 'bowl' }] },
      });

      // B never made that correction, so it does not resolve at full confidence for them.
      expect(forB.json().items[0].confidenceBand).not.toBe('confident');
    });
  });

  describe('calorie visibility (NUTRITION_ARCHITECTURE.md §8)', () => {
    it('omits energy from every payload when showCalories is false', async () => {
      const { foodId } = await findFood('cơm trắng');
      await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 2, unit: 'bowl' }] },
      });

      await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me/preferences',
        headers: bearer(token),
        payload: { showCalories: false },
      });

      const meal = await harness.app.inject({
        method: 'GET',
        url: '/api/meals/today',
        headers: bearer(token),
      });
      const daily = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/daily',
        headers: bearer(token),
      });
      const weekly = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/weekly',
        headers: bearer(token),
      });

      // Not null, not hidden — absent. The number never reaches the browser, which is
      // the only way the setting can actually be honoured.
      const first = meal.json().data[0];
      expect(first.totals).not.toHaveProperty('kcal');
      expect(first.items[0].nutrition).not.toHaveProperty('kcal');
      expect(daily.json()).not.toHaveProperty('nutrition');
      expect(weekly.json().totals).not.toHaveProperty('kcal');

      // 390 appears nowhere in any of the three payloads. Timestamps are stripped
      // first: an ISO instant carries milliseconds, so roughly one run in a thousand
      // would produce a createdAt ending in .390Z and fail this for no reason.
      for (const response of [meal, daily, weekly]) {
        const withoutTimestamps = response.body.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '');
        expect(withoutTimestamps).not.toContain('390');
      }

      // The behavioural figures are still there — the day is not blanked out.
      expect(daily.json().focus.mealsLogged).toBe(1);
      expect(first.totals.proteinG).toBeGreaterThan(0);
    });

    it('sends energy again when the setting is turned back on', async () => {
      const { foodId } = await findFood('cơm trắng');
      await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 2, unit: 'bowl' }] },
      });

      const daily = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/daily',
        headers: bearer(token),
      });
      expect(daily.json().nutrition.kcal).toBe(390);
    });
  });

  describe('ownership', () => {
    it('returns 404 when another user reads a meal', async () => {
      const { foodId } = await findFood('cơm trắng');
      const meal = await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 1, unit: 'bowl' }] },
      });

      for (const method of ['GET', 'DELETE'] as const) {
        const response = await harness.app.inject({
          method,
          url: `/api/meals/${meal.json().id}`,
          headers: bearer(tokenB),
        });
        expect(response.statusCode, method).toBe(404);
      }

      const patched = await harness.app.inject({
        method: 'PATCH',
        url: `/api/meals/${meal.json().id}`,
        headers: bearer(tokenB),
        payload: { items: [{ foodId, quantity: 99, unit: 'bowl' }] },
      });
      expect(patched.statusCode).toBe(404);

      // Untouched.
      const rows = await harness.sql`select total_kcal from meals where id = ${meal.json().id}`;
      expect(Number(rows[0]?.['total_kcal'])).toBe(195);
    });

    it('rejects an unauthenticated meal request', async () => {
      for (const url of ['/api/meals/today', '/api/nutrition/daily', '/api/nutrition/weekly']) {
        const response = await harness.app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(401);
      }
    });

    it('keeps each user daily totals separate', async () => {
      const { foodId } = await findFood('cơm trắng');
      await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 2, unit: 'bowl' }] },
      });

      const forB = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/daily',
        headers: bearer(tokenB),
      });
      expect(forB.json().nutrition.kcal).toBeNull();
      expect(forB.json().focus.mealsLogged).toBe(0);
    });
  });

  describe('daily and weekly aggregation', () => {
    it('sums a day from its items', async () => {
      const rice = await findFood('cơm trắng');
      const egg = await findFood('trứng luộc');

      await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'breakfast', items: [{ foodId: egg.foodId, quantity: 2, unit: 'piece' }] },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId: rice.foodId, quantity: 2, unit: 'bowl' }] },
      });

      const daily = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/daily',
        headers: bearer(token),
      });

      // 2 eggs at 50 g = 100 g = 155 kcal, plus 300 g of rice = 390 kcal.
      expect(daily.json().nutrition.kcal).toBe(545);
      expect(daily.json().focus.mealsLogged).toBe(2);
      expect(daily.json().focus.distinctFoods).toBe(2);
    });

    it('reports an empty day honestly rather than as zero intake', async () => {
      const daily = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/daily',
        headers: bearer(token),
      });

      expect(daily.json().focus.mealsLogged).toBe(0);
      // Null, not 0: nothing was logged, which is not the same as having eaten nothing.
      expect(daily.json().nutrition.kcal).toBeNull();
    });

    it('averages weekly figures over days logged, not over seven', async () => {
      const { foodId } = await findFood('cơm trắng');
      await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', items: [{ foodId, quantity: 2, unit: 'bowl' }] },
      });

      const weekly = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/weekly',
        headers: bearer(token),
      });

      expect(weekly.statusCode).toBe(200);
      expect(weekly.json().daysLogged).toBe(1);
      expect(weekly.json().totals.kcal).toBe(390);
      // Dividing by seven would report a drop that describes the tracking, not the eating.
      expect(weekly.json().averages.kcal).toBe(390);
      expect(weekly.json().isEstimate).toBe(true);
    });

    it('reports a week with nothing logged as zero days rather than zero calories', async () => {
      const weekly = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/weekly',
        headers: bearer(token),
      });

      expect(weekly.json().daysLogged).toBe(0);
      expect(weekly.json().days).toEqual([]);
      expect(weekly.json().averages.kcal).toBeNull();
    });

    it('excludes drafts from every total', async () => {
      const { foodId } = await findFood('cơm trắng');
      await harness.app.inject({
        method: 'POST',
        url: '/api/meals',
        headers: bearer(token),
        payload: { mealType: 'lunch', status: 'draft', items: [{ foodId, quantity: 2, unit: 'bowl' }] },
      });

      const daily = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/daily',
        headers: bearer(token),
      });
      expect(daily.json().nutrition.kcal).toBeNull();
      expect(daily.json().focus.mealsLogged).toBe(0);
    });

    it('rejects a reversed date range', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/nutrition/weekly?from=2026-09-10&to=2026-09-01',
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
