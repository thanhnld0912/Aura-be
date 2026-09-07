import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, stubDatabase } from '../helpers/app.js';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe('GET /api/health', () => {
  it('returns 200 and the documented shape when the database answers', async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      uptime: expect.any(Number),
      checks: { database: 'ok' },
    });
  });

  it('returns 503 when the database check fails', async () => {
    app = await buildTestApp({ database: stubDatabase({ pingFails: true }) });
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe('error');
    expect(response.json().checks.database).toBe('error');
  });

  it('needs no authentication', async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
  });

  it('leaks no driver detail when the database is down', async () => {
    app = await buildTestApp({ database: stubDatabase({ pingFails: true }) });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.body).not.toContain('connection refused');
  });
});
