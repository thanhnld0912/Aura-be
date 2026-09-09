import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestApp, testEnv } from '../helpers/app.js';

/**
 * The OpenAPI document and Swagger UI.
 *
 * Documentation is only useful if it describes the thing that actually runs, so these
 * tests assert the document is generated from the routes' own Zod schemas rather than
 * hand-written — and, just as importantly, that adding it changed nothing about the
 * API's behaviour or its security headers.
 */
describe('OpenAPI documentation', () => {
  let app: FastifyInstance;
  let document: {
    openapi: string;
    info: { title: string; version: string; description: string };
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { securitySchemes: Record<string, unknown> };
    security: unknown;
    tags: Array<{ name: string }>;
  };

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    document = response.json();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('serving', () => {
    it('serves Swagger UI at /docs', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs' });
      // The UI redirects to its trailing-slash form before rendering.
      expect([200, 302]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(404);
    });

    it('serves the UI page itself', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs/' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('serves the OpenAPI document as JSON', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs/json' });
      expect(response.statusCode).toBe(200);
      expect(() => response.json()).not.toThrow();
    });

    it('can be turned off entirely', async () => {
      const disabled = await buildTestApp({ env: testEnv({ DOCS_ENABLED: 'false' }) });
      try {
        expect((await disabled.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
        // The API is unaffected by the switch.
        expect((await disabled.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      } finally {
        await disabled.close();
      }
    });
  });

  describe('the document', () => {
    it('declares the requested identity', () => {
      expect(document.openapi).toMatch(/^3\./);
      expect(document.info.title).toBe('AURA API');
      expect(document.info.description).toContain('AURA AI Health & Fitness Companion API');
      expect(document.info.version).toBe('1.0.0');
    });

    it('offers bearer JWT authentication, which is what draws the Authorize button', () => {
      expect(document.components.securitySchemes['bearerAuth']).toMatchObject({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      expect(document.security).toEqual([{ bearerAuth: [] }]);
    });

    it('groups operations under tags', () => {
      expect(document.tags.map((tag) => tag.name)).toEqual(
        expect.arrayContaining(['Health', 'Auth', 'Users', 'Meals', 'Nutrition']),
      );
    });

    it('documents every endpoint the task asked for', () => {
      const expected: Array<[string, string]> = [
        ['get', '/api/health'],
        ['post', '/api/auth/session'],
        ['get', '/api/auth/me'],
        ['post', '/api/auth/logout'],
        ['get', '/api/users/me'],
        ['get', '/api/users/me/preferences'],
        ['patch', '/api/users/me/preferences'],
        ['get', '/api/daily-plan'],
        ['post', '/api/daily-plan'],
        ['get', '/api/events'],
        ['post', '/api/events'],
        ['get', '/api/checkins'],
        ['post', '/api/checkins'],
        ['post', '/api/meals'],
        ['post', '/api/meals/parse'],
        ['get', '/api/meals/today'],
        ['get', '/api/meals/{id}'],
        ['patch', '/api/meals/{id}'],
        ['post', '/api/meals/{id}/confirm'],
        ['delete', '/api/meals/{id}'],
        ['get', '/api/nutrition/search'],
        ['post', '/api/nutrition/calculate'],
        ['get', '/api/nutrition/daily'],
        ['get', '/api/nutrition/weekly'],
      ];

      const missing = expected.filter(([method, path]) => !document.paths[path]?.[method]);
      expect(missing).toEqual([]);
    });

    it('marks the three unauthenticated endpoints, and only those', () => {
      const unauthenticated: string[] = [];
      for (const [path, item] of Object.entries(document.paths)) {
        for (const [method, operation] of Object.entries(item)) {
          const security = (operation as { security?: unknown[] }).security;
          if (Array.isArray(security) && security.length === 0) {
            unauthenticated.push(`${method.toUpperCase()} ${path}`);
          }
        }
      }

      expect(unauthenticated.sort()).toEqual([
        'GET /api/health',
        'GET /api/nutrition/search',
        'POST /api/auth/session',
      ]);
    });
  });

  describe('schemas derived from the routes themselves', () => {
    const bodyOf = (path: string, method: string): Record<string, unknown> | undefined =>
      (
        document.paths[path]?.[method] as
          | { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } }
          | undefined
      )?.requestBody?.content['application/json']?.schema;

    it('describes the meal parse body from its Zod schema', () => {
      const body = bodyOf('/api/meals/parse', 'post');
      expect(Object.keys(body?.['properties'] as object)).toEqual(
        expect.arrayContaining(['text', 'mealType']),
      );
      expect(body?.['required']).toEqual(['text']);
    });

    it('describes the nutrition calculate body, including its nested items', () => {
      const body = bodyOf('/api/nutrition/calculate', 'post');
      const items = (body?.['properties'] as { items?: Record<string, unknown> }).items;
      expect(items?.['type']).toBe('array');
      expect(items?.['items']).toBeDefined();
    });

    it('describes query parameters', () => {
      const operation = document.paths['/api/nutrition/search']?.['get'] as {
        parameters?: Array<{ name: string; in: string }>;
      };
      const names = (operation.parameters ?? []).map((p) => `${p.name}:${p.in}`);
      expect(names).toEqual(expect.arrayContaining(['q:query', 'limit:query']));
    });

    it('describes path parameters', () => {
      const operation = document.paths['/api/meals/{id}']?.['get'] as {
        parameters?: Array<{ name: string; in: string }>;
      };
      expect((operation.parameters ?? []).some((p) => p.name === 'id' && p.in === 'path')).toBe(
        true,
      );
    });

    it('gives every operation at least one 2xx response', () => {
      const without: string[] = [];
      for (const [path, item] of Object.entries(document.paths)) {
        for (const [method, operation] of Object.entries(item)) {
          const responses = (operation as { responses?: Record<string, unknown> }).responses ?? {};
          if (!Object.keys(responses).some((code) => code.startsWith('2'))) {
            without.push(`${method.toUpperCase()} ${path}`);
          }
        }
      }
      expect(without).toEqual([]);
    });

    it('documents the health check as it really answers, including 503', () => {
      const responses = (
        document.paths['/api/health']?.['get'] as { responses: Record<string, unknown> }
      ).responses;
      expect(Object.keys(responses).sort()).toEqual(['200', '503']);
    });

    it('describes a 204 as no content rather than a null type OpenAPI 3.0 rejects', () => {
      const responses = (
        document.paths['/api/events/{id}']?.['delete'] as { responses: Record<string, unknown> }
      ).responses;
      expect(JSON.stringify(responses)).not.toContain('"type":"null"');
    });
  });

  describe('what the document must never contain', () => {
    it('leaks no secret name or value', () => {
      const serialized = JSON.stringify(document);
      for (const forbidden of [
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'USDA_API_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        'SUPABASE_JWT_SECRET',
        'DATABASE_URL',
        'postgresql://',
        // The test suite's own signing key, in case an example ever quoted a token.
        'a-test-jwt-secret',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('does not document Swagger UI own asset routes as API endpoints', () => {
      const docsPaths = Object.keys(document.paths).filter((path) => path.startsWith('/docs'));
      expect(docsPaths).toEqual([]);
    });
  });

  describe('nothing about the API changed', () => {
    it('still answers the health check', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('keeps the strict API content security policy, which the docs page does not share', async () => {
      const api = await app.inject({ method: 'GET', url: '/api/health' });
      expect(String(api.headers['content-security-policy'])).toContain("default-src 'none'");

      // Swagger UI sets its own, looser policy on its own routes only — otherwise the
      // page could not load its scripts.
      const docs = await app.inject({ method: 'GET', url: '/docs/' });
      expect(String(docs.headers['content-security-policy'])).not.toContain("default-src 'none'");
    });

    it('still refuses an unauthenticated request to a protected route', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/users/me' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('still validates request bodies through Zod, not the documented copy', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { accessToken: '' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('the registration guard still bites', () => {
    // A fresh instance, because the shared one is already listening and refuses new
    // routes outright — which would mask the guard rather than exercise it.
    it('rejects an API route with no response schema', async () => {
      const fresh = await buildTestApp();
      try {
        expect(() => fresh.get('/api/_undocumented', async () => ({}))).toThrow(/response schema/);
      } finally {
        await fresh.close();
      }
    });

    it('rejects a mutating API route with no body schema', async () => {
      const fresh = await buildTestApp();
      try {
        expect(() =>
          fresh.post(
            '/api/_nobody',
            { schema: { response: { 200: z.object({}) } } },
            async () => ({}),
          ),
        ).toThrow(/body schema/);
      } finally {
        await fresh.close();
      }
    });

    it('exempts only the docs prefix, which no /api route can reach', async () => {
      const fresh = await buildTestApp();
      try {
        // The exemption is a fixed prefix, not something a route opts into.
        expect(() => fresh.get('/docsomething', async () => ({}))).toThrow(/response schema/);
        expect(() => fresh.get('/api/docs', async () => ({}))).toThrow(/response schema/);
      } finally {
        await fresh.close();
      }
    });
  });
});
