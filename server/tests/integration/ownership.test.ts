import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * The horizontal privilege escalation matrix.
 *
 * Two real users, every Phase 2 resource, every verb. A resource owned by someone else
 * must return **404**, never 403 and never the row — the two are deliberately
 * indistinguishable so the API cannot be used to enumerate which ids exist
 * (SECURITY.md §2).
 */
describe.skipIf(!hasDatabase)('resource ownership', () => {
  let harness: DatabaseHarness;
  let tokenA: string;
  let tokenB: string;

  const userA = testUserId('a');
  const userB = testUserId('b');

  beforeAll(async () => {
    harness = await createDatabaseHarness();
    tokenA = await signTestToken({ sub: userA, email: 'a@example.com' });
    tokenB = await signTestToken({ sub: userB, email: 'b@example.com' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    // Provision both users.
    for (const token of [tokenA, tokenB]) {
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
  });

  async function createEventAs(token: string, title = 'Evening walk'): Promise<string> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/events',
      headers: bearer(token),
      payload: { type: 'walk', title, occurredAt: '2026-09-07T10:00:00Z', durationMin: 30 },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function createPlanAs(token: string, localDate = '2026-09-07'): Promise<string> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/daily-plan',
      headers: bearer(token),
      payload: {
        localDate,
        items: [{ eventType: 'walk', title: 'Morning walk', plannedTime: '07:00' }],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  describe('daily events', () => {
    it('lets a user read their own event', async () => {
      const eventId = await createEventAs(tokenA);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/events?from=2026-09-07&to=2026-09-07',
        headers: bearer(tokenA),
      });
      expect(response.json().data.map((e: { id: string }) => e.id)).toContain(eventId);
    });

    it('hides another user event from the list', async () => {
      const eventId = await createEventAs(tokenA, 'A private walk');
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/events?from=2026-09-01&to=2026-09-30',
        headers: bearer(tokenB),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
      expect(response.body).not.toContain(eventId);
      expect(response.body).not.toContain('A private walk');
    });

    it('returns 404 when user B updates user A event', async () => {
      const eventId = await createEventAs(tokenA);
      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/api/events/${eventId}`,
        headers: bearer(tokenB),
        payload: { title: 'Hijacked' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');

      // And the row is untouched.
      const rows = await harness.sql`select title from daily_events where id = ${eventId}`;
      expect(rows[0]?.['title']).toBe('Evening walk');
    });

    it('returns 404 when user B deletes user A event, and the row survives', async () => {
      const eventId = await createEventAs(tokenA);
      const response = await harness.app.inject({
        method: 'DELETE',
        url: `/api/events/${eventId}`,
        headers: bearer(tokenB),
      });

      expect(response.statusCode).toBe(404);
      const rows = await harness.sql`
        select deleted_at from daily_events where id = ${eventId}`;
      expect(rows[0]?.['deleted_at']).toBeNull();
    });

    it('gives the same 404 for a foreign id and a nonexistent id', async () => {
      const eventId = await createEventAs(tokenA);
      const foreign = await harness.app.inject({
        method: 'PATCH',
        url: `/api/events/${eventId}`,
        headers: bearer(tokenB),
        payload: { title: 'x' },
      });
      const nonexistent = await harness.app.inject({
        method: 'PATCH',
        url: '/api/events/99999999-9999-4999-8999-999999999999',
        headers: bearer(tokenB),
        payload: { title: 'x' },
      });

      expect(foreign.statusCode).toBe(nonexistent.statusCode);
      expect(foreign.json().error).toEqual({
        ...nonexistent.json().error,
        requestId: foreign.json().error.requestId,
      });
    });
  });

  describe('daily plans', () => {
    it('does not return another user plan for the same date', async () => {
      await createPlanAs(tokenA);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/daily-plan?date=2026-09-07',
        headers: bearer(tokenB),
      });
      expect(response.statusCode).toBe(404);
    });

    it('lets each user hold their own plan for the same date', async () => {
      await createPlanAs(tokenA);
      await createPlanAs(tokenB);

      const forA = await harness.app.inject({
        method: 'GET',
        url: '/api/daily-plan?date=2026-09-07',
        headers: bearer(tokenA),
      });
      const forB = await harness.app.inject({
        method: 'GET',
        url: '/api/daily-plan?date=2026-09-07',
        headers: bearer(tokenB),
      });

      expect(forA.statusCode).toBe(200);
      expect(forB.statusCode).toBe(200);
      expect(forA.json().id).not.toBe(forB.json().id);
    });

    it('returns 404 when user B rewrites user A plan items', async () => {
      const planId = await createPlanAs(tokenA);
      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/api/daily-plan/${planId}`,
        headers: bearer(tokenB),
        payload: { items: [{ eventType: 'workout', title: 'Injected', plannedTime: '20:00' }] },
      });

      expect(response.statusCode).toBe(404);
      const items = await harness.sql`
        select title from plan_items where plan_id = ${planId}`;
      expect(items.map((row) => row['title'])).toEqual(['Morning walk']);
    });

    it('returns 404 when user B deletes user A plan, and the plan survives', async () => {
      const planId = await createPlanAs(tokenA);
      const response = await harness.app.inject({
        method: 'DELETE',
        url: `/api/daily-plan/${planId}`,
        headers: bearer(tokenB),
      });

      expect(response.statusCode).toBe(404);
      const rows = await harness.sql`select count(*)::int as count from daily_plans where id = ${planId}`;
      expect(rows[0]?.['count']).toBe(1);
    });

    it('never reconciles one user plan against another user events', async () => {
      await createPlanAs(tokenA);
      // User B logs a walk at the planned time; it must not satisfy A's plan.
      await harness.app.inject({
        method: 'POST',
        url: '/api/events',
        headers: bearer(tokenB),
        payload: { type: 'walk', title: 'B walk', occurredAt: '2026-09-07T00:00:00Z' },
      });

      const comparison = await harness.app.inject({
        method: 'GET',
        url: '/api/daily-plan/comparison?date=2026-09-07',
        headers: bearer(tokenA),
      });

      expect(comparison.statusCode).toBe(200);
      expect(comparison.json().items[0].actual).toBeNull();
      expect(comparison.json().unplanned).toEqual([]);
    });
  });

  describe('check-ins', () => {
    it('keeps each user check-in separate on the same day', async () => {
      await harness.app.inject({
        method: 'POST',
        url: '/api/checkins',
        headers: bearer(tokenA),
        payload: { localDate: '2026-09-07', mood: 'great', note: 'A private note' },
      });

      const listB = await harness.app.inject({
        method: 'GET',
        url: '/api/checkins?from=2026-09-01&to=2026-09-30',
        headers: bearer(tokenB),
      });

      expect(listB.json().data).toEqual([]);
      expect(listB.body).not.toContain('A private note');
    });
  });

  describe('profile', () => {
    it('scopes /users/me to the caller, whichever token is used', async () => {
      const a = await harness.app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: bearer(tokenA),
      });
      const b = await harness.app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: bearer(tokenB),
      });

      expect(a.json().user.id).toBe(userA);
      expect(b.json().user.id).toBe(userB);
    });

    it('cannot be pointed at another user by request body', async () => {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: bearer(tokenA),
        payload: { displayName: 'Thanh', userId: userB, id: userB },
      });

      // Unknown keys are rejected outright rather than ignored (SECURITY.md §3).
      expect(response.statusCode).toBe(400);

      const rows = await harness.sql`select display_name from users where id = ${userB}`;
      expect(rows[0]?.['display_name']).toBeNull();
    });

    it('applies a valid profile update only to the caller', async () => {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: bearer(tokenA),
        payload: { displayName: 'Thanh', timezone: 'Asia/Bangkok' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().user).toMatchObject({
        displayName: 'Thanh',
        timezone: 'Asia/Bangkok',
      });

      const other = await harness.sql`select timezone from users where id = ${userB}`;
      expect(other[0]?.['timezone']).toBe('Asia/Ho_Chi_Minh');
    });

    it('rejects an invalid timezone rather than storing it', async () => {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: bearer(tokenA),
        payload: { timezone: 'Mars/Olympus_Mons' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('enforces the 13+ age gate (SECURITY.md §7)', async () => {
      const tooYoung = new Date();
      tooYoung.setUTCFullYear(tooYoung.getUTCFullYear() - 12);

      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: bearer(tokenA),
        payload: { dateOfBirth: tooYoung.toISOString().slice(0, 10) },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('UNDERAGE');
    });

    it('accepts a date of birth comfortably over 13', async () => {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: bearer(tokenA),
        payload: { dateOfBirth: '2000-01-01' },
      });
      expect(response.statusCode).toBe(200);
    });
  });
});
