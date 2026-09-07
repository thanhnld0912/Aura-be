import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import type { Database, Db } from '../../src/database/client.js';

export const TEST_ORIGIN = 'http://localhost:3000';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/aura_test',
    CORS_ORIGIN: TEST_ORIGIN,
    RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });
}

/**
 * A stand-in for the real database. Mocks live in tests only (Rule 35) — production
 * code always talks to Postgres — but the HTTP layer's behaviour under a healthy and
 * an unreachable database is worth testing without one.
 */
export function stubDatabase(options: { pingFails?: boolean } = {}): Database {
  return {
    db: {} as Db,
    sql: {} as Database['sql'],
    async ping() {
      if (options.pingFails) throw new Error('connection refused');
    },
    async close() {},
  };
}

export async function buildTestApp(
  options: { env?: Env; database?: Database } = {},
): Promise<FastifyInstance> {
  return buildApp({
    env: options.env ?? testEnv(),
    database: options.database ?? stubDatabase(),
    logger: false,
  });
}
