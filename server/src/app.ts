import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { Database } from './database/client.js';
import { loggerOptions } from './lib/logger.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { generateRequestId, registerRequestContext } from './middleware/request-context.js';
import { registerSecurity } from './middleware/security.js';
import { registerValidation } from './middleware/validation.js';
import { registerRoutes } from './routes/index.js';

export interface BuildAppOptions {
  env: Env;
  database: Database;
  /** Tests pass `false` to keep output clean. */
  logger?: boolean;
}

/**
 * Composition root. Everything the server needs is passed in, so a test can build a
 * fully wired app against a stub database without touching `process.env` or opening
 * a socket.
 *
 * Registration order is load-bearing in one place: the Zod compilers and the
 * `onRoute` guard must be installed *before* any route registers, or the guard
 * cannot see it.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env, database } = options;

  const app = Fastify({
    // Logged by pino as `reqId`, returned to the client as the `X-Request-Id`
    // header, and quoted in the error envelope as `requestId`.
    genReqId: generateRequestId,
    // Behind Railway's proxy the real client IP is only in X-Forwarded-For, and
    // rate-limit buckets key off it. Not trusted in development, where there is no
    // proxy and the header would be caller-controlled.
    trustProxy: env.NODE_ENV === 'production',
    // SECURITY.md §3 — 1 MB JSON cap. Uploads use multipart and their own limit.
    bodyLimit: 1_048_576,
    logger: options.logger === false ? false : loggerOptions(env),
  });

  registerRequestContext(app);
  registerValidation(app);
  registerErrorHandler(app);

  await registerSecurity(app, env);
  await registerRateLimit(app, env);

  await app.register(registerRoutes, { prefix: '/api', database });

  return app;
}
