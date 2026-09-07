import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/database/client.js';
import { testEnv } from '../helpers/app.js';

/**
 * The only test that needs a real PostgreSQL. It runs in CI against the `postgres:16`
 * service container and is skipped locally when `TEST_DATABASE_URL` is unset, so the
 * rest of the suite stays runnable without Docker.
 *
 * Run `npm run db:migrate` against the same database first — CI does.
 */
const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('database-backed health check', () => {
  let database: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = testEnv({ DATABASE_URL: url as string });
    database = createDatabase(env);
    app = await buildApp({ env, database, logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it('answers a real ping', async () => {
    await expect(database.ping()).resolves.toBeUndefined();
  });

  it('returns 200 from GET /api/health against a live database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });

  it('has applied migration 0000 — pg_trgm and unaccent are installed', async () => {
    const rows = await database.db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname in ('pg_trgm', 'unaccent') order by extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(['pg_trgm', 'unaccent']);
  });

  it('recorded the migration in drizzle’s journal table', async () => {
    const rows = await database.db.execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('is reachable through the pool the app actually uses', async () => {
    const rows = await database.db.execute<{ one: number }>(sql`select 1 as one`);
    expect(rows[0]?.one).toBe(1);
  });
});
