import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthenticatedError } from '../../lib/errors.js';
import { bucket } from '../../middleware/rate-limit.js';
import { meResponseSchema, toMeResponse, userProfileSchema } from '../users/users.schema.js';
import { requireUser } from './auth.plugin.js';
import type { AuthService } from './auth.service.js';
import type { SupabaseAuthClient } from './supabase-auth-client.js';

/** `/api/auth` (API_DESIGN.md §4). */

export const sessionRequestSchema = z
  .object({ accessToken: z.string().min(1).max(4096) })
  .strict();

export const sessionResponseSchema = z.object({
  user: userProfileSchema.extend({
    /** Lets the client route to onboarding without a second call. */
    isNewUser: z.boolean(),
  }),
});

export async function authRoutes(
  app: FastifyInstance,
  options: { authService: AuthService; supabaseAuth: SupabaseAuthClient },
): Promise<void> {
  const { authService, supabaseAuth } = options;

  /**
   * Exchanges a Supabase access token for a verified AURA identity, provisioning the
   * user row on first contact.
   *
   * This is the one authenticated-by-body endpoint — the token arrives in the payload
   * rather than the header — so it is also the one that cannot use the `authenticate`
   * preHandler. It is limited by IP at 10 per 15 minutes to blunt credential stuffing
   * (SECURITY.md §5).
   */
  app.post(
    '/session',
    {
      config: { rateLimit: bucket('auth') },
      schema: { body: sessionRequestSchema, response: { 200: sessionResponseSchema } },
    },
    async (request) => {
      const { accessToken } = request.body as z.infer<typeof sessionRequestSchema>;
      const provisioned = await authService.createSession(accessToken);
      const { user } = toMeResponse(provisioned);
      return { user: { ...user, isNewUser: provisioned.isNewUser } };
    },
  );

  /** Used on app boot to decide onboarding vs. home. */
  app.get(
    '/me',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: meResponseSchema } },
    },
    async (request) => toMeResponse(await authService.currentUser(requireUser(request).id)),
  );

  app.post(
    '/logout',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write'), skipBodySchema: true },
      schema: { response: { 204: z.null() } },
    },
    async (request, reply) => {
      // The preHandler already proved this header is a valid token; re-reading it is
      // how we know *which* session to revoke.
      const header = request.headers.authorization;
      const token = header?.split(' ')[1];
      if (!token) throw new UnauthenticatedError();

      await supabaseAuth.revokeSession(token);
      return reply.status(204).send();
    },
  );
}
