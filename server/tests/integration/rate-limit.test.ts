import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RATE_LIMIT_BUCKETS, bucket } from '../../src/middleware/rate-limit.js';
import { buildTestApp, testEnv } from '../helpers/app.js';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

async function appWithLimitedRoute(): Promise<FastifyInstance> {
  const instance = await buildTestApp({ env: testEnv({ RATE_LIMIT_ENABLED: 'true' }) });
  instance.get(
    '/api/_test/limited',
    {
      config: { rateLimit: { max: 2, timeWindow: '1 minute' } },
      schema: { response: { 200: z.object({ ok: z.boolean() }) } },
    },
    async () => ({ ok: true }),
  );
  await instance.ready();
  return instance;
}

describe('rate limiting (API_DESIGN.md §17)', () => {
  it('defines every documented bucket', () => {
    expect(RATE_LIMIT_BUCKETS.global).toEqual({ max: 300, timeWindow: '15 minutes' });
    expect(bucket('ai-vision')).toEqual({ max: 20, timeWindow: '1 day' });
    expect(bucket('ai-heavy')).toEqual({ max: 3, timeWindow: '1 day' });
    expect(bucket('auth')).toEqual({ max: 10, timeWindow: '15 minutes' });
  });

  it('returns 429 in the standard envelope with Retry-After once a bucket is spent', async () => {
    app = await appWithLimitedRoute();

    for (let i = 0; i < 2; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/api/_test/limited' })).statusCode).toBe(200);
    }

    const limited = await app.inject({ method: 'GET', url: '/api/_test/limited' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.json().error.requestId).toEqual(expect.any(String));
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('advertises the documented rate-limit headers', async () => {
    app = await appWithLimitedRoute();
    const response = await app.inject({ method: 'GET', url: '/api/_test/limited' });

    expect(response.headers['x-ratelimit-limit']).toBe('2');
    expect(response.headers['x-ratelimit-remaining']).toBe('1');
    expect(response.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('exempts the health check, which the platform polls continuously', async () => {
    app = await buildTestApp({ env: testEnv({ RATE_LIMIT_ENABLED: 'true' }) });
    for (let i = 0; i < 20; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    }
  });
});
