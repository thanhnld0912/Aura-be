import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { bucket } from '../../middleware/rate-limit.js';
import { requireUser } from '../auth/auth.plugin.js';
import { agentChatBodySchema, agentChatResponseSchema } from './agent.schema.js';
import type { AgentService } from './agent.service.js';

/** `/api/agent` (API_DESIGN.md §15). */
export async function agentRoutes(
  app: FastifyInstance,
  options: { agentService: AgentService },
): Promise<void> {
  const { agentService } = options;

  /**
   * One message, one reply, as JSON. The `ai-chat` bucket (30/hour) applies to every
   * message, including ones the safety gate answers without a model.
   */
  app.post(
    '/chat',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('ai-chat') },
      schema: { body: agentChatBodySchema, response: { 200: agentChatResponseSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { message } = request.body as z.infer<typeof agentChatBodySchema>;
      return agentService.chat(user, message);
    },
  );
}
