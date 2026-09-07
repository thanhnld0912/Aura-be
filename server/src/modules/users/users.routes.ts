import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import type { UsersService } from './users.service.js';
import {
  deleteAccountResponseSchema,
  deleteAccountSchema,
  meResponseSchema,
  toMeResponse,
  updatePreferencesSchema,
  updateProfileSchema,
} from './users.schema.js';

/**
 * `/api/users` (API_DESIGN.md §5).
 *
 * Every handler reads its user from `requireUser(request)` — the verified token — and
 * never from a path or body. There is no `:userId` route here, by design: an endpoint
 * that accepts a user id is an endpoint that can be pointed at somebody else.
 */
export async function usersRoutes(
  app: FastifyInstance,
  options: { usersService: UsersService },
): Promise<void> {
  const { usersService } = options;

  app.get(
    '/me',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: meResponseSchema } },
    },
    async (request) => toMeResponse(await usersService.getProfile(requireUser(request).id)),
  );

  app.patch(
    '/me',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { body: updateProfileSchema, response: { 200: meResponseSchema } },
    },
    async (request) => {
      const patch = request.body as z.infer<typeof updateProfileSchema>;
      return toMeResponse(await usersService.updateProfile(requireUser(request).id, patch));
    },
  );

  app.get(
    '/me/preferences',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: meResponseSchema.shape.preferences } },
    },
    async (request) =>
      toMeResponse(await usersService.getProfile(requireUser(request).id)).preferences,
  );

  app.patch(
    '/me/preferences',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: {
        body: updatePreferencesSchema,
        response: { 200: meResponseSchema.shape.preferences },
      },
    },
    async (request) => {
      const patch = request.body as z.infer<typeof updatePreferencesSchema>;
      const updated = await usersService.updatePreferences(requireUser(request).id, patch);
      return toMeResponse(updated).preferences;
    },
  );

  app.delete(
    '/me',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write'), skipBodySchema: false },
      schema: { body: deleteAccountSchema, response: { 202: deleteAccountResponseSchema } },
    },
    async (request, reply) => {
      await usersService.deleteAccount(requireUser(request).id);
      return reply.status(202).send({ status: 'scheduled' as const, hardDeleteAfterDays: 30 });
    },
  );
}
