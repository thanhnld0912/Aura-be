import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../../src/lib/logger.js';
import { parseEnv } from '../../src/config/env.js';

const env = (overrides: Record<string, string> = {}) =>
  parseEnv({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/aura',
    CORS_ORIGIN: 'http://localhost:3000',
    NODE_ENV: 'test',
    ...overrides,
  });

const options = (overrides?: Record<string, string>) => loggerOptions(env(overrides)) as any;

const fakeRequest = {
  method: 'GET',
  url: '/api/nutrition/search?q=th%E1%BB%8Bt%20kho&limit=10',
  routeOptions: { url: '/api/nutrition/search' },
  ip: '203.0.113.4',
  headers: { authorization: 'Bearer secret-token', cookie: 'a=b' },
} as unknown as FastifyRequest;

describe('logger configuration (SECURITY.md §9)', () => {
  it('redacts credential-bearing headers', () => {
    const { redact } = options();
    expect(redact.paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ]),
    );
    expect(redact.remove).toBe(true);
  });

  it('logs only named request fields — never headers or the body', () => {
    const serialized = options().serializers.req(fakeRequest);

    expect(serialized).toEqual({
      method: 'GET',
      path: '/api/nutrition/search',
      route: '/api/nutrition/search',
      ip: '203.0.113.4',
    });
    expect(JSON.stringify(serialized)).not.toContain('secret-token');
  });

  it('drops the query string, which can carry user-authored text', () => {
    expect(options().serializers.req(fakeRequest).path).not.toContain('q=');
  });

  it('logs the response status and nothing else', () => {
    const serialized = options().serializers.res({
      statusCode: 429,
      getHeaders: () => ({ 'set-cookie': 'session=x' }),
    });
    expect(serialized).toEqual({ statusCode: 429 });
  });

  it('honours LOG_LEVEL and only pretty-prints in development', () => {
    expect(options({ LOG_LEVEL: 'debug' }).level).toBe('debug');
    expect(options().transport).toBeUndefined();
    expect(options({ NODE_ENV: 'development' }).transport.target).toBe('pino-pretty');
  });
});
