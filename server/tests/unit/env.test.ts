import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../../src/config/env.js';

const minimal = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/aura',
  CORS_ORIGIN: 'http://localhost:3000',
  SUPABASE_URL: 'https://project.supabase.co',
};

describe('parseEnv', () => {
  it('applies documented defaults', () => {
    const env = parseEnv(minimal);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.MAX_UPLOAD_BYTES).toBe(8_388_608);
    expect(env.AI_MODEL_VISION).toBe('gemini-2.5-flash');
    expect(env.CRON_TIMEZONE).toBe('Asia/Ho_Chi_Minh');
  });

  it('fails loudly when a required variable is missing', () => {
    expect(() => parseEnv({ CORS_ORIGIN: 'http://localhost:3000' })).toThrow(EnvValidationError);
  });

  it('requires SUPABASE_URL from Phase 2 — there is no authentication without it', () => {
    const { SUPABASE_URL, ...withoutSupabase } = minimal;
    expect(() => parseEnv(withoutSupabase)).toThrow(/SUPABASE_URL/);
  });

  it('names the offending variable in the message', () => {
    try {
      parseEnv({ ...minimal, PORT: 'not-a-port' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).message).toContain('PORT');
    }
  });

  /**
   * A real misconfiguration, and a silent one: Supabase's newer dashboard identifies
   * each signing key by a UUID, that UUID is published in the project's JWKS, and
   * pasting it here would make the verifier accept HS256 tokens signed with a public
   * value. Asymmetric tokens keep working throughout, so nothing looks wrong.
   */
  it('refuses a JWT signing key ID in place of the signing secret', () => {
    // Not a real key id — the shape is the whole point.
    expect(() =>
      parseEnv({ ...minimal, SUPABASE_JWT_SECRET: '00000000-0000-4000-8000-000000000000' }), // gitleaks:allow
    ).toThrow(/SUPABASE_JWT_SECRET/);

    expect(() =>
      parseEnv({ ...minimal, SUPABASE_JWT_SECRET: '00000000-0000-4000-8000-00000000ABCD' }), // gitleaks:allow
    ).toThrow(/published in your project JWKS/);
  });

  it('still accepts a genuine legacy HS256 secret', () => {
    const env = parseEnv({
      ...minimal,
      // 40 alphanumeric characters, the legacy Supabase shape.
      SUPABASE_JWT_SECRET: 'q7Rk2wZpL9xTn4vB8sMdC1yH6jF3aE0gU5iOtQwX', // gitleaks:allow
    });
    expect(env.SUPABASE_JWT_SECRET).toHaveLength(40);
  });

  it('parses CORS_ORIGIN into an allowlist and rejects a non-URL entry', () => {
    expect(parseEnv({ ...minimal, CORS_ORIGIN: 'http://a.test, https://b.test' }).CORS_ORIGIN).toEqual([
      'http://a.test',
      'https://b.test',
    ]);
    expect(() => parseEnv({ ...minimal, CORS_ORIGIN: '*' })).toThrow(EnvValidationError);
  });

  it('coerces booleans from strings', () => {
    expect(parseEnv({ ...minimal, RATE_LIMIT_ENABLED: 'false' }).RATE_LIMIT_ENABLED).toBe(false);
    expect(parseEnv({ ...minimal, CRON_ENABLED: '1' }).CRON_ENABLED).toBe(true);
    expect(() => parseEnv({ ...minimal, RATE_LIMIT_ENABLED: 'yes' })).toThrow(EnvValidationError);
  });

  it('leaves keys that later phases require optional, so the server boots without them', () => {
    const env = parseEnv(minimal);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SUPABASE_JWT_SECRET).toBeUndefined();
  });
});
