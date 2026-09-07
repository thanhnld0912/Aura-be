import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/client.js';
import { healthResponseSchema } from './health.schema.js';
import { HealthService } from './health.service.js';

/**
 * `GET /api/health` — the one unauthenticated, unmetered endpoint. It is polled by
 * the platform every few seconds, so it is exempt from the global rate limit; a
 * throttled health check would restart a perfectly healthy container.
 */
export async function healthRoutes(
  app: FastifyInstance,
  options: { database: Database },
): Promise<void> {
  const health = new HealthService().register({
    name: 'database',
    critical: true,
    cacheMs: 0,
    run: () => options.database.ping(),
  });

  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        response: {
          200: healthResponseSchema,
          503: healthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const { body, statusCode } = await health.report();
      return reply.status(statusCode).send(body);
    },
  );
}
