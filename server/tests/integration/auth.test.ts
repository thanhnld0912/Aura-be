import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, signTestToken, TEST_ISSUER } from '../helpers/app.js';
import {
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * Authentication and JIT provisioning against a real database.
 *
 * The security matrix here is the point: no token, malformed token, expired token,
 * forged signature, wrong issuer, wrong audience — all 401, all identical.
 */
describe.skipIf(!hasDatabase)('authentication', () => {
  let harness: DatabaseHarness;
  const userA = testUserId('a');

  beforeAll(async () => {
    harness = await createDatabaseHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  describe('rejection', () => {
    const protectedRoute = { method: 'GET' as const, url: '/api/users/me' };

    it('rejects a request with no Authorization header', async () => {
      const response = await harness.app.inject(protectedRoute);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a malformed Authorization header', async () => {
      for (const authorization of ['', 'Bearer', 'Basic abc', 'abc', 'Bearer ']) {
        const response = await harness.app.inject({ ...protectedRoute, headers: { authorization } });
        expect(response.statusCode, authorization).toBe(401);
      }
    });

    it('rejects a token that is not a JWT', async () => {
      const response = await harness.app.inject({
        ...protectedRoute,
        headers: bearer('not.a.jwt'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an expired token', async () => {
      const token = await signTestToken({ sub: userA, expiresIn: '-1h' });
      const response = await harness.app.inject({ ...protectedRoute, headers: bearer(token) });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a token from another issuer', async () => {
      const token = await signTestToken({ sub: userA, issuer: 'https://evil.example/auth/v1' });
      const response = await harness.app.inject({ ...protectedRoute, headers: bearer(token) });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a token for another audience', async () => {
      const token = await signTestToken({ sub: userA, audience: 'anon' });
      const response = await harness.app.inject({ ...protectedRoute, headers: bearer(token) });
      expect(response.statusCode).toBe(401);
    });

    it('leaks nothing about which check failed', async () => {
      const [expired, wrongIssuer, missing] = await Promise.all([
        harness.app.inject({
          ...protectedRoute,
          headers: bearer(await signTestToken({ sub: userA, expiresIn: '-1h' })),
        }),
        harness.app.inject({
          ...protectedRoute,
          headers: bearer(await signTestToken({ sub: userA, issuer: 'https://evil.example/auth/v1' })),
        }),
        harness.app.inject(protectedRoute),
      ]);

      const bodies = [expired, wrongIssuer, missing].map((r) => r.json().error.message);
      expect(new Set(bodies).size).toBe(1);
    });

    it('does not provision a user for a rejected token', async () => {
      await harness.app.inject({
        ...protectedRoute,
        headers: bearer(await signTestToken({ sub: userA, expiresIn: '-1h' })),
      });
      const rows = await harness.sql`select count(*)::int as count from users`;
      expect(rows[0]?.['count']).toBe(0);
    });
  });

  describe('JIT provisioning (DATABASE_DESIGN.md §3.1)', () => {
    it('creates the AURA user on the first authenticated request', async () => {
      const token = await signTestToken({ sub: userA, email: 'thanh@example.com' });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().user).toMatchObject({
        id: userA,
        email: 'thanh@example.com',
        timezone: 'Asia/Ho_Chi_Minh',
        locale: 'vi',
        streakDays: 0,
      });
    });

    it('creates preferences and the system habits alongside the user', async () => {
      const token = await signTestToken({ sub: userA });
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });

      const preferences = await harness.sql`
        select * from user_preferences where user_id = ${userA}`;
      expect(preferences).toHaveLength(1);
      expect(preferences[0]?.['show_calories']).toBe(true);

      const habits = await harness.sql`
        select key from habits where user_id = ${userA} and is_system order by key`;
      expect(habits.map((row) => row['key'])).toEqual([
        'meal_logging_consistency',
        'plan_adherence',
        'sleep_consistency',
        'workout_consistency',
      ]);
    });

    it('is idempotent across repeated requests', async () => {
      const token = await signTestToken({ sub: userA });
      for (let i = 0; i < 3; i += 1) {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/api/users/me',
          headers: bearer(token),
        });
        expect(response.statusCode).toBe(200);
      }

      const rows = await harness.sql`select count(*)::int as count from users`;
      expect(rows[0]?.['count']).toBe(1);

      const habits = await harness.sql`
        select count(*)::int as count from habits where user_id = ${userA}`;
      expect(habits[0]?.['count']).toBe(4);
    });

    it('survives concurrent first requests without duplicating or failing', async () => {
      // The real race: a mobile client retrying, or several tabs opening at once. A
      // read-then-insert would have one of these fail on the primary key.
      const token = await signTestToken({ sub: userA });
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) }),
        ),
      );

      expect(responses.every((r) => r.statusCode === 200)).toBe(true);

      const users = await harness.sql`select count(*)::int as count from users`;
      expect(users[0]?.['count']).toBe(1);
      const habits = await harness.sql`
        select count(*)::int as count from habits where user_id = ${userA}`;
      expect(habits[0]?.['count']).toBe(4);
    });

    it('rejects a verified token with no email rather than half-provisioning', async () => {
      const token = await signTestToken({ sub: userA, email: null });
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(401);
      const rows = await harness.sql`select count(*)::int as count from users`;
      expect(rows[0]?.['count']).toBe(0);
    });
  });

  describe('POST /api/auth/session', () => {
    it('provisions and reports a first visit', async () => {
      const accessToken = await signTestToken({ sub: userA, email: 'thanh@example.com' });

      const first = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { accessToken },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json().user).toMatchObject({ id: userA, isNewUser: true });

      const second = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { accessToken },
      });
      expect(second.json().user.isNewUser).toBe(false);
    });

    it('refreshes the email when Supabase reports a new one', async () => {
      await harness.app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { accessToken: await signTestToken({ sub: userA, email: 'old@example.com' }) },
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { accessToken: await signTestToken({ sub: userA, email: 'new@example.com' }) },
      });

      expect(response.json().user.email).toBe('new@example.com');
    });

    it('does not preserve a client-supplied identity over the token', async () => {
      const accessToken = await signTestToken({ sub: userA });
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/session',
        // An extra key is rejected outright rather than quietly ignored.
        payload: { accessToken, userId: testUserId('b') },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a bad token without a database write', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { accessToken: await signTestToken({ sub: userA, issuer: 'https://evil.test/auth/v1' }) },
      });

      expect(response.statusCode).toBe(401);
      const rows = await harness.sql`select count(*)::int as count from users`;
      expect(rows[0]?.['count']).toBe(0);
    });
  });

  describe('GET /api/auth/me and sign-out', () => {
    it('returns the profile and preferences the client boots from', async () => {
      const token = await signTestToken({ sub: userA });
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        user: { id: userA },
        preferences: { showCalories: true, goalFocus: 'consistency' },
      });
    });

    it('revokes the refresh token at Supabase on logout', async () => {
      const token = await signTestToken({ sub: userA });
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(204);
      expect(harness.supabaseAuth.revoked).toEqual([token]);
    });

    it('refuses to authenticate a soft-deleted account', async () => {
      const token = await signTestToken({ sub: userA });
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });

      const deleted = await harness.app.inject({
        method: 'DELETE',
        url: '/api/users/me',
        headers: bearer(token),
        payload: { confirm: 'DELETE' },
      });
      expect(deleted.statusCode).toBe(202);

      // The token is still cryptographically valid; the account is not.
      const after = await harness.app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: bearer(token),
      });
      expect(after.statusCode).toBe(401);
    });
  });

  it('issues tokens under the configured Supabase issuer', () => {
    expect(TEST_ISSUER).toBe('https://project.supabase.co/auth/v1');
  });
});
