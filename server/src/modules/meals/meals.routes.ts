import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParamSchema } from '../../lib/api-schemas.js';
import { todayIn } from '../../lib/local-date.js';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import type { UsersService } from '../users/users.service.js';
import type { MealsService } from './meals.service.js';
import {
  createMealSchema,
  mealListSchema,
  mealQuerySchema,
  mealSchema,
  parseMealSchema,
  parsedMealSchema,
  toMealResponse,
  updateMealSchema,
} from './meals.schema.js';

/**
 * `/api/meals`.
 *
 * Every response goes through `toMealResponse` with the user's preferences, which is
 * where `showCalories` is honoured — by omitting the field, not by hiding it.
 */
export async function mealsRoutes(
  app: FastifyInstance,
  options: { mealsService: MealsService; usersService: UsersService },
): Promise<void> {
  const { mealsService, usersService } = options;

  /** One preferences read per request, rather than one per meal being serialized. */
  const serializeOptions = async (userId: string): Promise<{ showCalories: boolean }> => {
    const profile = await usersService.getProfile(userId);
    return { showCalories: profile.preferences.showCalories };
  };

  app.post(
    '/',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { body: createMealSchema, response: { 201: mealSchema } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof createMealSchema>;

      const created = await mealsService.create(user.id, user.timezone, {
        mealType: body.mealType,
        items: body.items,
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.occurredAt !== undefined ? { occurredAt: body.occurredAt } : {}),
      });

      return reply.status(201).send(toMealResponse(created, await serializeOptions(user.id)));
    },
  );

  /**
   * Natural language to a reviewable draft. The parser reads the sentence; every number
   * in the response comes from the food database afterwards.
   */
  app.post(
    '/parse',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('ai-text') },
      schema: { body: parseMealSchema, response: { 200: parsedMealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof parseMealSchema>;

      const result = await mealsService.parseToDraft(
        user.id,
        user.timezone,
        body.text,
        body.mealType,
      );

      return {
        meal: toMealResponse(result.meal, await serializeOptions(user.id)),
        ambiguous: result.ambiguous,
        parser: result.parser,
      };
    },
  );

  app.get(
    '/today',
    {
      preHandler: app.authenticate,
      schema: { querystring: mealQuerySchema, response: { 200: mealListSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const query = request.query as z.infer<typeof mealQuerySchema>;

      const meals = await mealsService.listForDay(
        user.id,
        query.date ?? todayIn(user.timezone),
        query.includeDrafts === 'true',
      );

      const serialize = await serializeOptions(user.id);
      return { data: meals.map((meal) => toMealResponse(meal, serialize)) };
    },
  );

  app.get(
    '/:id',
    {
      preHandler: app.authenticate,
      schema: { params: idParamSchema, response: { 200: mealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const meal = await mealsService.get(user.id, id);
      return toMealResponse(meal, await serializeOptions(user.id));
    },
  );

  /**
   * The user corrects a meal. Their edit pins every item to full confidence and teaches
   * the resolver, so the same phrase resolves correctly next time.
   */
  app.patch(
    '/:id',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { params: idParamSchema, body: updateMealSchema, response: { 200: mealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const body = request.body as z.infer<typeof updateMealSchema>;

      const updated = await mealsService.replaceItems(user.id, id, user.timezone, body.items);
      return toMealResponse(updated, await serializeOptions(user.id));
    },
  );

  app.post(
    '/:id/confirm',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write'), skipBodySchema: true },
      schema: { params: idParamSchema, response: { 200: mealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const confirmed = await mealsService.confirm(user.id, id, user.timezone);
      return toMealResponse(confirmed, await serializeOptions(user.id));
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
      await mealsService.softDelete(user.id, id, user.timezone);
      return reply.status(204).send();
    },
  );
}
