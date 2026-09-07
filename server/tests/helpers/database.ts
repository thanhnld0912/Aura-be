import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { buildApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/database/client.js';
import { stubSupabaseAuth, testEnv } from './app.js';

/**
 * Harness for the tests that need a real PostgreSQL.
 *
 * Gated on `TEST_DATABASE_URL` so the suite still runs without Docker; CI sets it and
 * a guard step fails the build if these tests skip there (DEPLOYMENT.md §5), so the
 * gate cannot quietly turn into "never runs".
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const hasDatabase = Boolean(TEST_DATABASE_URL);

/** A non-owner, non-superuser role, which is the only way to observe RLS at work. */
export const RLS_ROLE = 'aura_rls_test';

/** Tables emptied between tests. `users` cascades to nearly everything. */
const TRUNCATE_TABLES = [
  'users',
  'foods',
  'daily_summaries',
] as const;

export interface DatabaseHarness {
  app: FastifyInstance;
  database: Database;
  /** A raw connection for the assertions and setup the API deliberately cannot do. */
  sql: postgres.Sql;
  supabaseAuth: ReturnType<typeof stubSupabaseAuth>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createDatabaseHarness(): Promise<DatabaseHarness> {
  const url = TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');

  const env = testEnv({ DATABASE_URL: url });
  const database = createDatabase(env);
  const supabaseAuth = stubSupabaseAuth();
  const app = await buildApp({ env, database, supabaseAuth, logger: false });
  const sql = postgres(url, { max: 4, prepare: false, onnotice: () => {} });

  await ensureRlsRole(sql);

  return {
    app,
    database,
    sql,
    supabaseAuth,
    async reset() {
      await sql.unsafe(`truncate table ${TRUNCATE_TABLES.join(', ')} restart identity cascade`);
    },
    async close() {
      await app.close();
      await database.close();
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Creates the role the RLS tests act as.
 *
 * It exists only in tests, and deliberately so: on Supabase this role is `anon` or
 * `authenticated`, which the platform creates and grants for us. Locally there is no
 * such role, and without one every RLS assertion would silently pass — the backend
 * connects as the table owner, which bypasses policies by design.
 */
async function ensureRlsRole(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${RLS_ROLE}') then
        create role ${RLS_ROLE} nologin;
      end if;
    end
    $$;
  `);

  await sql.unsafe(`grant usage on schema public to ${RLS_ROLE}`);
  await sql.unsafe(`grant usage on schema auth to ${RLS_ROLE}`);
  await sql.unsafe(
    `grant select, insert, update, delete on all tables in schema public to ${RLS_ROLE}`,
  );
  await sql.unsafe(`grant execute on all functions in schema auth to ${RLS_ROLE}`);
}

/**
 * Runs a query the way PostgREST would for a signed-in user: as a non-owner role, with
 * the JWT claims set on the connection so `auth.uid()` resolves. `SET LOCAL` confines
 * both to the transaction, so nothing leaks to the next test or the pooled connection.
 *
 * Pass `userId: null` to act as an unauthenticated caller.
 */
export async function asRlsUser<T>(
  sql: postgres.Sql,
  userId: string | null,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${RLS_ROLE}`);
    if (userId === null) {
      await tx.unsafe(`set local request.jwt.claims = ''`);
    } else {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`;
    }
    return run(tx);
  }) as Promise<T>;
}

/** A stable uuid per label, so failures name a user rather than a random id. */
export function testUserId(label: 'a' | 'b'): string {
  return label === 'a'
    ? '11111111-1111-4111-8111-111111111111'
    : '22222222-2222-4222-8222-222222222222';
}
