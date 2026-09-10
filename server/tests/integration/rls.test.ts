import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, signTestToken } from '../helpers/app.js';
import {
  asRlsUser,
  createDatabaseHarness,
  hasDatabase,
  testUserId,
  type DatabaseHarness,
} from '../helpers/database.js';

/**
 * Row Level Security — the second lock (DATABASE_DESIGN.md §6).
 *
 * These tests do **not** go through the API. They connect as a non-owner role with the
 * JWT claims set on the connection, which is exactly how Supabase evaluates policies
 * for a request arriving through PostgREST with a leaked anon key. That is the threat
 * RLS exists for; the API's own connection bypasses these policies by design, so
 * testing through the API would prove nothing about them.
 */
describe.skipIf(!hasDatabase)('row level security', () => {
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
    for (const token of [tokenA, tokenB]) {
      await harness.app.inject({ method: 'GET', url: '/api/users/me', headers: bearer(token) });
    }
    // One event and one plan for each user, written through the API.
    for (const [token, title] of [
      [tokenA, 'A walk'],
      [tokenB, 'B walk'],
    ] as const) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/events',
        headers: bearer(token),
        payload: { type: 'walk', title, occurredAt: '2026-09-07T10:00:00Z' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/daily-plan',
        headers: bearer(token),
        payload: {
          localDate: '2026-09-07',
          items: [{ eventType: 'walk', title, plannedTime: '17:00' }],
        },
      });
    }

    // `ai_runs` has no endpoint — the service writes it through the owning connection,
    // so that is how it is seeded here.
    for (const userId of [userA, userB]) {
      await harness.sql`
        insert into ai_runs (user_id, purpose, provider, model, status, latency_ms, attempt)
        values (${userId}, 'meal_parse', 'anthropic', 'test-model', 'ok', 12, 1)`;
    }
  });

  it('the shim resolves auth.uid() from the connection claims', async () => {
    const asA = await asRlsUser(harness.sql, userA, (tx) => tx`select auth.uid() as uid`);
    expect(asA[0]?.['uid']).toBe(userA);

    const anonymous = await asRlsUser(harness.sql, null, (tx) => tx`select auth.uid() as uid`);
    expect(anonymous[0]?.['uid']).toBeNull();
  });

  describe('an unauthenticated connection', () => {
    it('sees no rows in any user-owned table', async () => {
      const counts = await asRlsUser(harness.sql, null, async (tx) => ({
        users: await tx`select count(*)::int as c from users`,
        events: await tx`select count(*)::int as c from daily_events`,
        plans: await tx`select count(*)::int as c from daily_plans`,
        planItems: await tx`select count(*)::int as c from plan_items`,
        summaries: await tx`select count(*)::int as c from daily_summaries`,
        habits: await tx`select count(*)::int as c from habits`,
      }));

      for (const [table, rows] of Object.entries(counts)) {
        expect(rows[0]?.['c'], table).toBe(0);
      }
    });

    it('cannot insert a row on someone else behalf', async () => {
      await expect(
        asRlsUser(
          harness.sql,
          null,
          (tx) => tx`
            insert into daily_events (user_id, local_date, type, occurred_at, title)
            values (${userA}, '2026-09-07', 'walk', now(), 'injected')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('user A signed in', () => {
    it('sees only their own events', async () => {
      const rows = await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`select title, user_id from daily_events order by title`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['title']).toBe('A walk');
      expect(rows[0]?.['user_id']).toBe(userA);
    });

    it('sees only their own user row and preferences', async () => {
      const users = await asRlsUser(harness.sql, userA, (tx) => tx`select id from users`);
      expect(users.map((r) => r['id'])).toEqual([userA]);

      const preferences = await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`select user_id from user_preferences`,
      );
      expect(preferences.map((r) => r['user_id'])).toEqual([userA]);
    });

    it('sees only their own plan items, which carry no user_id of their own', async () => {
      // plan_items scopes through daily_plans; if that EXISTS clause were wrong this
      // would return both users' items.
      const rows = await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`select title from plan_items order by title`,
      );
      expect(rows.map((r) => r['title'])).toEqual(['A walk']);
    });

    it('sees only their own daily summary', async () => {
      const rows = await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`select user_id from daily_summaries`,
      );
      expect(rows.map((r) => r['user_id'])).toEqual([userA]);
    });

    it('sees only their own ai_runs', async () => {
      const rows = await asRlsUser(harness.sql, userA, (tx) => tx`select user_id from ai_runs`);
      expect(rows.map((r) => r['user_id'])).toEqual([userA]);
    });

    it('cannot read user B ai_runs even by naming the id', async () => {
      const rows = await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`select * from ai_runs where user_id = ${userB}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot attribute an ai_run to user B', async () => {
      // The cost ledger is keyed by user; a write policy that only checked USING would
      // let one account bill another.
      await expect(
        asRlsUser(
          harness.sql,
          userA,
          (tx) => tx`
            insert into ai_runs (user_id, purpose, provider, model, status, latency_ms, attempt)
            values (${userB}, 'chat', 'anthropic', 'test-model', 'ok', 5, 1)`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('cannot read user B rows even by naming the id', async () => {
      const rows = await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`select * from daily_events where user_id = ${userB}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot update user B event — the update matches no visible row', async () => {
      await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`update daily_events set title = 'hijacked' where user_id = ${userB}`,
      );

      const rows = await harness.sql`
        select title from daily_events where user_id = ${userB}`;
      expect(rows[0]?.['title']).toBe('B walk');
    });

    it('cannot delete user B event', async () => {
      await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`delete from daily_events where user_id = ${userB}`,
      );

      const rows = await harness.sql`
        select count(*)::int as c from daily_events where user_id = ${userB}`;
      expect(rows[0]?.['c']).toBe(1);
    });

    it('cannot insert an event attributed to user B', async () => {
      await expect(
        asRlsUser(
          harness.sql,
          userA,
          (tx) => tx`
            insert into daily_events (user_id, local_date, type, occurred_at, title)
            values (${userB}, '2026-09-07', 'walk', now(), 'injected')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('cannot reassign their own event to user B', async () => {
      // WITH CHECK is what stops this: the row is visible, but the *result* would not be.
      await expect(
        asRlsUser(
          harness.sql,
          userA,
          (tx) => tx`update daily_events set user_id = ${userB} where user_id = ${userA}`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('cannot attach a plan item to user B plan', async () => {
      const [plan] = await harness.sql`
        select id from daily_plans where user_id = ${userB} limit 1`;

      await expect(
        asRlsUser(
          harness.sql,
          userA,
          (tx) => tx`
            insert into plan_items (plan_id, event_type, title, planned_time)
            values (${plan?.['id'] as string}, 'walk', 'injected', '09:00')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('user B signed in', () => {
    it('sees only their own events — the policy is symmetric', async () => {
      const rows = await asRlsUser(harness.sql, userB, (tx) => tx`select title from daily_events`);
      expect(rows.map((r) => r['title'])).toEqual(['B walk']);
    });
  });

  describe('reference data', () => {
    it('is readable by anyone, because it belongs to nobody', async () => {
      await harness.sql`
        insert into foods (canonical_name, search_name, search_name_en, name_en, provider, external_id)
        values ('com trang', 'com trang', 'white rice', 'White rice', 'local', 'vn-rice-01')`;

      const signedIn = await asRlsUser(
        harness.sql,
        userA,
        (tx) => tx`select canonical_name from foods`,
      );
      expect(signedIn).toHaveLength(1);

      const anonymous = await asRlsUser(harness.sql, null, (tx) => tx`select id from foods`);
      expect(anonymous).toHaveLength(1);
    });

    it('is not writable by a signed-in user — there is no write policy', async () => {
      await expect(
        asRlsUser(
          harness.sql,
          userA,
          (tx) => tx`
            insert into foods (canonical_name, search_name, search_name_en, name_en, provider, external_id)
            values ('fake', 'fake', 'fake', 'Fake', 'local', 'vn-fake-01')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('the backend connection', () => {
    it('is not subject to the policies — RLS is the second lock, not the first', async () => {
      // The API's own connection owns the tables, so it sees everything. This is the
      // documented design (DATABASE_DESIGN.md §6): ownership is enforced in the
      // repository layer, and the test above proves that layer works.
      const rows = await harness.sql`select count(*)::int as c from daily_events`;
      expect(rows[0]?.['c']).toBe(2);
    });

    it('has RLS enabled on every user-owned table', async () => {
      const rows = await harness.sql`
        select c.relname as table_name, c.relrowsecurity as enabled
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`;

      const withoutRls = rows.filter((row) => row['enabled'] !== true).map((r) => r['table_name']);
      expect(withoutRls).toEqual([]);
      // 15 from Phase 2, user_food_aliases from Phase 3, ai_runs from Phase 4.
      expect(rows.length).toBe(17);
    });

    it('has a policy on every table that has RLS enabled', async () => {
      const rows = await harness.sql`
        select c.relname as table_name, count(p.polname)::int as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'public' and c.relkind = 'r'
        group by c.relname
        having count(p.polname) = 0`;

      expect(rows.map((r) => r['table_name'])).toEqual([]);
    });
  });
});
