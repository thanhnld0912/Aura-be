import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import type { InsightsService } from './insights.service.js';
import {
  weeklyQuerySchema,
  weeklyReportSchema,
  weeklyStoryBodySchema,
  weeklyStoryResponseSchema,
} from './insights.schema.js';

/** `/api/insights` (API_DESIGN.md §13). */
export async function insightsRoutes(
  app: FastifyInstance,
  options: { insightsService: InsightsService },
): Promise<void> {
  const { insightsService } = options;

  /**
   * The week's facts — deterministic, and never a model call. Useful on its own, and the
   * thing a client falls back to whenever a story is unavailable.
   */
  app.get(
    '/weekly',
    {
      preHandler: app.authenticate,
      schema: { querystring: weeklyQuerySchema, response: { 200: weeklyReportSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { weekStart } = request.query as z.infer<typeof weeklyQuerySchema>;
      return insightsService.weeklyReport(user, weekStart);
    },
  );

  /**
   * Generates the week's story on request. `ai-heavy` — 3 a day — because this is a
   * reasoning-model call and nothing is cached (API_DESIGN.md §17).
   */
  app.post(
    '/weekly/story',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('ai-heavy') },
      schema: { body: weeklyStoryBodySchema, response: { 200: weeklyStoryResponseSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { weekStart } = request.body as z.infer<typeof weeklyStoryBodySchema>;
      return insightsService.weeklyStory(user, weekStart);
    },
  );
}
