import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { UnauthenticatedError } from '../../lib/errors.js';
import type { AuthService, AuthenticatedUser } from './auth.service.js';

/**
 * Installs `app.authenticate`, the preHandler every protected route opts into.
 *
 * Authentication is a route-level opt-in rather than a global hook on purpose: the
 * two unauthenticated endpoints in the whole API (`GET /api/health` and
 * `POST /api/auth/session`) are then visibly unauthenticated at their definition, and
 * a new route that forgets `preHandler` fails its ownership tests immediately rather
 * than silently inheriting a permissive default.
 */

function bearerTokenFrom(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) throw new UnauthenticatedError();

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthenticatedError();

  return token;
}

export function registerAuth(app: FastifyInstance, authService: AuthService): void {
  app.decorateRequest('authUser', null);

  const authenticate: preHandlerHookHandler = async (request) => {
    const token = bearerTokenFrom(request);
    request.authUser = await authService.authenticate(token);
  };

  app.decorate('authenticate', authenticate);
}

/**
 * The authenticated identity, or a 401. Handlers call this instead of reading
 * `request.authUser` directly so the non-null assertion lives in exactly one place and
 * a route that forgot its `preHandler` fails loudly rather than reading `undefined`.
 */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.authUser) throw new UnauthenticatedError();
  return request.authUser;
}
