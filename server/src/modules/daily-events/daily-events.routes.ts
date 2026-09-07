import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParamSchema } from '../../lib/api-schemas.js';
import { todayIn } from '../../lib/local-date.js';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import { decodeCursor, type DailyEventsService } from './daily-events.service.js';
import {
  createEventSchema,
  eventListSchema,
  eventSchema,
  listEventsQuerySchema,
  todayQuerySchema,
  toEventResponse,
  updateEventSchema,
} from './daily-events.schema.js';

/**
 * `/api/events` (API_DESIGN.md §7).
 *
 * Returns flat events; the frontend does its own Morning/Afternoon/Evening grouping
 * (audit §3.5), so the API stays a data contract rather than a view model.
 *
 * Every handler scopes to `requireUser(request).id`. There is no route that accepts a
 * user id, and `:id` alone never identifies a row — the repository always filters by
 * owner as well, so another user's event is a 404.
 */
export async function dailyEventsRoutes(
  app: FastifyInstance,
  options: { eventsService: DailyEventsService },
): Promise<void> {
  const { eventsService } = options;

  app.get(
    '/today',
    {
      preHandler: app.authenticate,
      schema: { querystring: todayQuerySchema, response: { 200: eventListSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { date } = request.query as z.infer<typeof todayQuerySchema>;
      // "Today" means today where the user is, not where the server is.
      const localDate = date ?? todayIn(user.timezone);
      const rows = await eventsService.listForDayRaw(user.id, localDate);
      return { data: rows.map(toEventResponse), nextCursor: null };
    },
  );

  app.get(
    '/',
    {
      preHandler: app.authenticate,
      schema: { querystring: listEventsQuerySchema, response: { 200: eventListSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const query = request.query as z.infer<typeof listEventsQuerySchema>;

      const result = await eventsService.list(user.id, {
        limit: query.limit,
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
        ...(query.type !== undefined ? { type: query.type } : {}),
        ...(query.cursor !== undefined ? { cursor: decodeCursor(query.cursor) } : {}),
      });

      return { data: result.data.map(toEventResponse), nextCursor: result.nextCursor };
    },
  );

  app.post(
    '/',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { body: createEventSchema, response: { 201: eventSchema } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof createEventSchema>;

      // Triggers reconciliation and a summary recompute — both synchronous, both
      // cheap, neither calls AI (API_DESIGN.md §7).
      const created = await eventsService.create(user.id, user.timezone, body);
      return reply.status(201).send(toEventResponse(created));
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: {
        params: idParamSchema,
        body: updateEventSchema,
        response: { 200: eventSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const patch = request.body as z.infer<typeof updateEventSchema>;

      const updated = await eventsService.update(user.id, id, user.timezone, patch);
      return toEventResponse(updated);
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

      // Soft delete — the Pattern Engine depends on history a swipe must not destroy.
      await eventsService.softDelete(user.id, id, user.timezone);
      return reply.status(204).send();
    },
  );
}
