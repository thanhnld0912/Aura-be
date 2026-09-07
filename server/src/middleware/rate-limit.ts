import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { RateLimitedError } from '../lib/errors.js';

/**
 * Rate limits serve three purposes at once (SECURITY.md §5): abuse prevention,
 * cost control — 20 vision calls/day bounds a user's AI spend — and protection of
 * upstream quotas, since USDA allows 1,000 requests/hour per key across *all* users.
 *
 * Buckets are per-user from the JWT, falling back to IP for unauthenticated routes.
 *
 * Store: in-memory. `SECURITY.md` §5 originally specified a Postgres-backed store at
 * MVP, but `DATABASE_DESIGN.md` defines no table for it and `DEPLOYMENT.md` §1/§8
 * runs MVP as a *single* always-on container, where a shared store buys nothing and
 * costs a round-trip on every request. The documented trigger to replace this is the
 * same one that introduces Redis: more than one API container (DEPLOYMENT.md §8,
 * Growth stage). Recorded in SECURITY.md §5.
 */

export interface Bucket {
  readonly max: number;
  readonly timeWindow: string;
}

/** API_DESIGN.md §17. Route-level buckets are applied from the phase that adds the route. */
export const RATE_LIMIT_BUCKETS = {
  global: { max: 300, timeWindow: '15 minutes' },
  auth: { max: 10, timeWindow: '15 minutes' },
  'ai-vision': { max: 20, timeWindow: '1 day' },
  'ai-text': { max: 10, timeWindow: '1 hour' },
  'ai-chat': { max: 30, timeWindow: '1 hour' },
  'ai-heavy': { max: 3, timeWindow: '1 day' },
  nutrition: { max: 60, timeWindow: '1 minute' },
  write: { max: 120, timeWindow: '1 hour' },
} as const satisfies Record<string, Bucket>;

export type BucketName = keyof typeof RATE_LIMIT_BUCKETS;

/** Use in a route's `config: { rateLimit: bucket('ai-vision') }`. */
export const bucket = (name: BucketName): Bucket => RATE_LIMIT_BUCKETS[name];

/**
 * Phase 1 has no authenticated routes, so this resolves to the IP for everything.
 * Phase 2 adds the verified `sub` from the JWT here — the single place a bucket key
 * is decided, for every bucket.
 */
export function rateLimitKey(request: FastifyRequest): string {
  return request.ip;
}

export async function registerRateLimit(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(rateLimit, {
    global: env.RATE_LIMIT_ENABLED,
    max: RATE_LIMIT_BUCKETS.global.max,
    timeWindow: RATE_LIMIT_BUCKETS.global.timeWindow,
    keyGenerator: rateLimitKey,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    // The plugin *throws* whatever this returns, so it must be an Error — returning
    // a bare envelope object lands in the error handler as an unrecognised value
    // and becomes a 500. Returning the AppError keeps 429s in the normal path.
    errorResponseBuilder: (_request, context) => new RateLimitedError(Number(context.ttl) / 1000),
  });
}
