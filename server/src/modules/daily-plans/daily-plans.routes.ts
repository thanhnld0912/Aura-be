import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParamSchema } from '../../lib/api-schemas.js';
import { todayIn } from '../../lib/local-date.js';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import type { DailyPlansService } from './daily-plans.service.js';
import {
  comparisonSchema,
  createPlanSchema,
  planDateQuerySchema,
  planSchema,
  toPlanResponse,
  updatePlanSchema,
} from './daily-plans.schema.js';

/** `/api/daily-plan` (API_DESIGN.md §6). */
export async function dailyPlansRoutes(
  app: FastifyInstance,
  options: { plansService: DailyPlansService },
): Promise<void> {
  const { plansService } = options;

  /**
   * The comparison route is declared before `/:id` so `comparison` is never parsed as
   * an id. Fastify's radix router prefers static segments anyway, but the ordering
   * makes the intent legible.
   */
  app.get(
    '/comparison',
    {
      preHandler: app.authenticate,
      schema: { querystring: planDateQuerySchema, response: { 200: comparisonSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { date } = request.query as z.infer<typeof planDateQuerySchema>;
      return plansService.comparison(
        user.id,
        date ?? todayIn(user.timezone),
        user.timezone,
      );
    },
  );

  app.get(
    '/',
    {
      preHandler: app.authenticate,
      schema: { querystring: planDateQuerySchema, response: { 200: planSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { date } = request.query as z.infer<typeof planDateQuerySchema>;
      // 404 when absent, so the client can render "create a plan" rather than an error.
      return toPlanResponse(await plansService.getByDate(user.id, date ?? todayIn(user.timezone)));
    },
  );

  app.post(
    '/',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { body: createPlanSchema, response: { 201: planSchema } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof createPlanSchema>;

      const created = await plansService.create(
        user.id,
        body.localDate,
        body.items,
        user.timezone,
      );
      return reply.status(201).send(toPlanResponse(created));
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { params: idParamSchema, body: updatePlanSchema, response: { 200: planSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const patch = request.body as z.infer<typeof updatePlanSchema>;

      let result = patch.items
        ? await plansService.replaceItems(user.id, id, patch.items, user.timezone)
        : undefined;

      if (patch.status) {
        result = await plansService.setStatus(user.id, id, patch.status);
      }

      // Neither field given is rejected by the schema, so one of the two always ran.
      return toPlanResponse(result ?? (await plansService.getById(user.id, id)));
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { params: idParamSchema, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      await plansService.delete(user.id, id);
      return reply.status(204).send();
    },
  );
}
