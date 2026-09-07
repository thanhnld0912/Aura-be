import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

/**
 * Every request carries a ULID `requestId`. It is the log correlation key, and the
 * one piece of internal state deliberately returned to the client — an error
 * envelope quotes it so a user report can be traced without exposing a stack
 * (SECURITY.md §9).
 *
 * The id is always generated here and never read from an inbound header: a
 * client-supplied value would let a caller poison or collide log correlation.
 */
export const generateRequestId = (): string => ulid();

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
}
