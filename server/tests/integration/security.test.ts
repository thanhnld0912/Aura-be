import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../helpers/app.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildTestApp();
});

afterEach(async () => {
  await app?.close();
});

describe('security headers (SECURITY.md §6)', () => {
  it('sets the API-appropriate hardening headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['strict-transport-security']).toContain('preload');
  });

  it("uses default-src 'none' — the right CSP for an API that serves no HTML", () => {
    return app
      .inject({ method: 'GET', url: '/api/health' })
      .then((response) => {
        expect(String(response.headers['content-security-policy'])).toContain("default-src 'none'");
      });
  });
});

describe('CORS allowlist (SECURITY.md §6)', () => {
  it('allows an origin on the allowlist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: TEST_ORIGIN },
    });
    expect(response.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an origin that is not on the allowlist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: TEST_ORIGIN },
    });
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('answers preflight for an allowed origin and permits the Authorization header', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: {
        origin: TEST_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
    expect(response.headers['access-control-max-age']).toBe('86400');
  });
});

describe('body limits (SECURITY.md §3)', () => {
  it('rejects a JSON body over the 1 MB cap with PAYLOAD_TOO_LARGE', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/health',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ note: 'x'.repeat(1_100_000) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('CSP describes an API, not a document', () => {
  it('emits only default-src none and the three lockdown directives', async () => {
    const csp = String(
      (await app.inject({ method: 'GET', url: '/api/health' })).headers[
        'content-security-policy'
      ],
    );

    expect(csp.split(';').map((d) => d.trim()).sort()).toEqual([
      "base-uri 'none'",
      "default-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
    // helmet's page-oriented defaults have no meaning for a JSON API.
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('style-src');
  });
});
