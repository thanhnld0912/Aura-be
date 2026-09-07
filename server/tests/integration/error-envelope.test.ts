import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../src/lib/errors.js';
import { buildTestApp } from '../helpers/app.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildTestApp();

  app.post(
    '/api/_test/echo',
    {
      schema: {
        body: z.object({ quantity: z.number().positive(), unit: z.enum(['chén', 'tô']) }),
        response: { 200: z.object({ quantity: z.number(), unit: z.string() }) },
      },
    },
    async (request) => request.body as { quantity: number; unit: string },
  );

  app.get(
    '/api/_test/boom',
    { schema: { response: { 200: z.object({}) } } },
    async () => {
      throw new Error('internal detail: postgres://user:hunter2@db:5432 at /srv/aura/x.ts:9');
    },
  );

  app.get('/api/_test/conflict', { schema: { response: { 200: z.object({}) } } }, async () => {
    throw new ConflictError('A plan already exists for 2026-09-07');
  });

  app.get('/api/_test/missing', { schema: { response: { 200: z.object({}) } } }, async () => {
    throw new NotFoundError();
  });
});

afterEach(async () => {
  await app?.close();
});

describe('error envelope', () => {
  it('returns 400 VALIDATION_ERROR with per-field details', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/_test/echo',
      payload: { quantity: 0, unit: 'chén' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual([{ path: 'quantity', issue: 'too_small' }]);
    expect(body.error.requestId).toEqual(expect.any(String));
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('closes enums rather than accepting arbitrary categorical values', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/_test/echo',
      payload: { quantity: 2, unit: 'bowl-ish' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toEqual([{ path: 'unit', issue: 'invalid_enum_value' }]);
  });

  it('rejects a malformed JSON body with the same envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/_test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"quantity": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('never returns internal detail or a stack trace on a 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/_test/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: expect.any(String),
    });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('/srv/aura');
    expect(response.body).not.toContain('Error:');
  });

  it('preserves an AppError message the API means to show', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/_test/conflict' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'CONFLICT',
      message: 'A plan already exists for 2026-09-07',
    });
  });

  it('returns the same envelope for an unknown route and for an unowned resource', async () => {
    const unknown = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    const unowned = await app.inject({ method: 'GET', url: '/api/_test/missing' });

    expect(unknown.statusCode).toBe(404);
    expect(unowned.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
    expect(unknown.json().error.message).toBe(unowned.json().error.message);
  });

  it('echoes the requestId in both the body and the X-Request-Id header', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/_test/boom' });
    expect(response.headers['x-request-id']).toBe(response.json().error.requestId);
    // ULID: 26 chars, Crockford base32.
    expect(response.json().error.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('gives every request a distinct id', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/health' });
    const b = await app.inject({ method: 'GET', url: '/api/health' });
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});

describe('route registration guard', () => {
  it('refuses to register a route with no response schema', () => {
    expect(() => app.get('/api/_test/unvalidated', async () => ({}))).toThrow(/response schema/);
  });

  it('refuses to register a mutating route with no body schema', () => {
    expect(() =>
      app.post(
        '/api/_test/unvalidated-body',
        { schema: { response: { 200: z.object({}) } } },
        async () => ({}),
      ),
    ).toThrow(/body schema/);
  });
});
