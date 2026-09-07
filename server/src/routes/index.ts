import type { FastifyInstance } from 'fastify';
import type { Database } from '../database/client.js';
import { healthRoutes } from '../modules/health/health.routes.js';

/**
 * The `/api` surface. Each module is a Fastify plugin, which is what gives the
 * modular monolith its boundaries: a module's routes, schemas and hooks are
 * encapsulated, so extracting one later means moving a directory rather than
 * untangling shared middleware (ARCHITECTURE.md §5).
 *
 * Modules land with their phases: `auth`, `users`, `daily-plans`, `daily-events`
 * and `checkins` in Phase 2; `nutrition` and `meals` in Phase 3; `agent` in
 * Phase 4; `patterns` and `insights` in Phase 5.
 */
export async function registerRoutes(
  app: FastifyInstance,
  options: { database: Database },
): Promise<void> {
  await app.register(healthRoutes, { database: options.database });
}
