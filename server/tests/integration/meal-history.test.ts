import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFoods } from '../../src/database/seeds/seed-foods.js';
import { todayIn } from '../../src/lib/local-date.js';
import { bearer, signTestToken } from '../helpers/app.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * A parsed meal, from review to History — the path a meal takes in the app.
 *
 * Describe mode parses to a **draft** (`POST /api/meals/parse`); only `POST
 * /api/meals/:id/confirm` creates the timeline event that History (`GET /api/events`)
 * lists. These tests pin that lifecycle end to end: a confirmed meal is in History on the
 * day it was logged and on every day after, for its owner only; an unconfirmed draft is
 * in History never.
 */
describe.skipIf(!hasDatabase)('meal history', () => {
  let harness: DatabaseHarness;
  let token: string;
  let tokenB: string;
  const userId = testUserId('a');
  const userBId = testUserId('b');
  // The profile default, which every test user is provisioned with.
  const timeZone = 'Asia/Ho_Chi_Minh';

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
    await seedFoods(harness.database.db);
    for (const t of [token, tokenB]) {
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(t) });
    }
  });

  const parse = (text: string) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/meals/parse',
      headers: bearer(token),
      payload: { text, mealType: 'breakfast' },
    });
  const confirm = (id: string, t = token) =>
    harness.app.inject({ method: 'POST', url: `/api/meals/${id}/confirm`, headers: bearer(t) });
  const history = async (t = token) => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/events', headers: bearer(t) });
    expect(response.statusCode).toBe(200);
    return response.json().data as Array<{ id: string; type: string; localDate: string; title: string }>;
  };

  it('lists a confirmed meal in History, on the local day it was logged', async () => {
    const draft = (await parse('tôi ăn 1 quả trứng và uống 1 hộp sữa ít đường')).json().meal;

    const confirmed = await confirm(draft.id);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ id: draft.id, status: 'confirmed' });
    const eventId = confirmed.json().eventId as string;
    expect(eventId).toEqual(expect.any(String));

    expect(await history()).toEqual([
      expect.objectContaining({ id: eventId, type: 'meal', localDate: todayIn(timeZone), title: 'Breakfast' }),
    ]);

    // And the meal itself, items intact, is today's — an unresolved item does not hide it.
    const today = await harness.app.inject({ method: 'GET', url: '/api/meals/today', headers: bearer(token) });
    expect(today.json().data.map((meal: { id: string }) => meal.id)).toEqual([draft.id]);
    expect(today.json().data[0].items).toHaveLength(2);
  });

  it('keeps it in History the next day, under the day it happened', async () => {
    const draft = (await parse('1 hộp sữa tươi')).json().meal;
    const eventId = (await confirm(draft.id)).json().eventId as string;

    // "The next day": the meal was logged yesterday. Move its event back 24 hours — the
    // same instant and local date the server would have stored then.
    const [moved] = await harness.sql<Array<{ local_date: string }>>`
      update daily_events
         set occurred_at = occurred_at - interval '1 day',
             local_date = local_date - 1
       where id = ${eventId}
      returning local_date::text as local_date`;
    const yesterday = moved!.local_date;

    expect(await history()).toEqual([expect.objectContaining({ id: eventId, type: 'meal', localDate: yesterday })]);

    const onThatDay = await harness.app.inject({
      method: 'GET',
      url: `/api/meals/today?date=${yesterday}`,
      headers: bearer(token),
    });
    expect(onThatDay.json().data.map((meal: { id: string }) => meal.id)).toEqual([draft.id]);

    // Today's list is today's only — which is why History, not Today, is where it is found.
    const today = await harness.app.inject({ method: 'GET', url: '/api/meals/today', headers: bearer(token) });
    expect(today.json().data).toEqual([]);
  });

  it('lists the meal after its amounts were corrected and then confirmed', async () => {
    const draft = (await parse('1 hộp sữa tươi')).json().meal;
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/meals/${draft.id}`,
      headers: bearer(token),
      payload: { items: [{ foodId: draft.items[0].foodId, quantity: 2, unit: 'piece' }] },
    });
    expect(patched.statusCode).toBe(200);

    const eventId = (await confirm(draft.id)).json().eventId as string;
    expect((await history()).map((event) => event.id)).toEqual([eventId]);
  });

  it('never lists a parsed meal that was not confirmed', async () => {
    const draft = (await parse('1 quả trứng')).json().meal;
    expect(draft.status).toBe('draft');

    // The draft is persisted — it is reviewable — but it is not something that happened.
    const rows = await harness.sql`select status, event_id from meals where id = ${draft.id}`;
    expect(rows).toEqual([{ status: 'draft', event_id: null }]);
    expect(await history()).toEqual([]);
  });

  it("shows a meal only in its owner's History", async () => {
    const draft = (await parse('1 quả trứng')).json().meal;

    // Another user can neither confirm it nor see it.
    expect((await confirm(draft.id, tokenB)).statusCode).toBe(404);
    expect(await history(tokenB)).toEqual([]);

    const eventId = (await confirm(draft.id)).json().eventId as string;
    expect((await history()).map((event) => event.id)).toEqual([eventId]);
    expect(await history(tokenB)).toEqual([]);

    const [row] = await harness.sql`select user_id from daily_events where id = ${eventId}`;
    expect(row?.['user_id']).toBe(userId);
  });

  it('confirms once: a repeated confirm is refused and adds nothing to History', async () => {
    const draft = (await parse('1 quả trứng')).json().meal;
    expect((await confirm(draft.id)).statusCode).toBe(200);
    expect((await confirm(draft.id)).statusCode).toBe(409);
    expect(await history()).toHaveLength(1);
  });
});
