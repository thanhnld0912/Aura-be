import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';

/**
 * Transport and header hardening (SECURITY.md §6).
 *
 * `default-src 'none'` is the correct CSP for a JSON API that serves no HTML, and
 * CORS is an explicit allowlist read from `CORS_ORIGIN` — never `*`, and never
 * reflected back from the `Origin` header.
 */
export async function registerSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      // Only these directives — helmet's browser-page defaults (script-src, style-src,
      // img-src, …) describe a document, and this server never returns one.
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    noSniff: true,
    // Irrelevant to a JSON API and noisy in responses.
    crossOriginEmbedderPolicy: false,
  });

  const allowlist = new Set(env.CORS_ORIGIN);

  await app.register(cors, {
    origin(origin, callback) {
      // Same-origin and non-browser clients (curl, the Android app) send no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowlist.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-AURA-Version',
      'Idempotency-Key',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 86_400,
  });
}
