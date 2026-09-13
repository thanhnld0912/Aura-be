import type { preHandlerHookHandler } from 'fastify';
import type { AuthenticatedUser } from '../modules/auth/auth.service.js';

/**
 * Fastify type augmentations owned by AURA.
 *
 * `skipBodySchema` is the only sanctioned way past the registration guard in
 * `middleware/validation.ts`. It exists for multipart routes (Phase 4's meal photo
 * upload), whose payload is validated by magic-byte sniffing rather than by Zod
 * (SECURITY.md §4). Keeping it typed here means the escape hatch is discoverable
 * rather than folded into an `any`.
 *
 * `authUser` is populated only by the `authenticate` preHandler, from a verified JWT.
 * It is typed as possibly null so a route that forgets the preHandler cannot read an
 * identity that was never established — `requireUser()` turns that into a 401.
 */
declare module 'fastify' {
  interface FastifyContextConfig {
    skipBodySchema?: boolean;
    /**
     * What a `skipBodySchema` route accepts, as OpenAPI should describe it: a JSON Schema
     * for its `multipart/form-data` body. Documentation only — the validator never sees
     * it, and the handler validates the stream itself (`middleware/openapi.ts`).
     */
    multipartBody?: Readonly<Record<string, unknown>>;
  }

  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
  }

  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
  }
}

export {};
