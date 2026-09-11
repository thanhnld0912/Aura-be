import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import type { Database, Db } from '../../src/database/client.js';
import type { SupabaseAuthClient } from '../../src/modules/auth/supabase-auth-client.js';
import type { MealParser } from '../../src/nutrition/parser/meal-parser.js';

export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_SUPABASE_URL = 'https://project.supabase.co';
// Not a secret: a fixed HS256 signing key so tests can mint tokens the real verifier
// accepts. Flagged by the generic-api-key rule purely for looking like one.
export const TEST_JWT_SECRET = 'a-test-jwt-secret-that-is-long-enough-for-hs256'; // gitleaks:allow
export const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/aura_test',
    CORS_ORIGIN: TEST_ORIGIN,
    RATE_LIMIT_ENABLED: 'false',
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    ...overrides,
  });
}

/**
 * Mints a token the app's verifier will accept. Tests sign with the same secret the
 * test env configures, so the whole auth path — signature, iss, aud, exp — runs for
 * real rather than being stubbed out.
 */
export async function signTestToken(options: {
  sub: string;
  email?: string | null;
  expiresIn?: string;
  issuer?: string;
  audience?: string;
}): Promise<string> {
  const claims: Record<string, unknown> = { role: 'authenticated' };
  if (options.email !== null) claims['email'] = options.email ?? `${options.sub}@example.com`;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.sub)
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

export const bearer = (token: string): { authorization: string } => ({
  authorization: `Bearer ${token}`,
});

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

/** Records sign-outs instead of calling Supabase. */
export function stubSupabaseAuth(): SupabaseAuthClient & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    async revokeSession(accessToken: string) {
      revoked.push(accessToken);
    },
  };
}

export async function buildTestApp(
  options: {
    env?: Env;
    database?: Database;
    supabaseAuth?: SupabaseAuthClient;
    mealParser?: MealParser;
  } = {},
): Promise<FastifyInstance> {
  return buildApp({
    env: options.env ?? testEnv(),
    database: options.database ?? stubDatabase(),
    supabaseAuth: options.supabaseAuth ?? stubSupabaseAuth(),
    ...(options.mealParser ? { mealParser: options.mealParser } : {}),
    logger: false,
  });
}
