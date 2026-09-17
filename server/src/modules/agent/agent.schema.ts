import { z } from 'zod';
import { SECTION_KINDS } from '../../agent/agent-reply.js';
import { AGENT_INTENTS } from '../../agent/intent.js';
import type { AgentChatResponse } from './agent.service.js';

/**
 * `/api/agent` (API_DESIGN.md §15, as built in Phase 4 Task 8).
 *
 * The request is a message and nothing else. `.strict()` makes every attempt to steer the
 * infrastructure a `400` — `userId`, `systemPrompt`, `model`, `provider`, `tools` — and so
 * is `conversationId`, because there is no conversation store for it to name.
 */
export const agentChatBodySchema = z
  .object({ message: z.string().trim().min(1).max(2000) })
  .strict();

const statementSchema = z.object({
  text: z.string(),
  /** Deterministic source ids: `metric:…`, `meal:…`, `plan:…`, `pattern:…`, `limitation:…`. */
  evidence: z.array(z.string()),
});

export const agentChatResponseSchema = z.object({
  /**
   * `answer` — a model reply that passed validation. `boundary` — out of AURA's scope.
   * `support` — the safety gate stopped the message and a fixed supportive reply was
   * returned. `disabled` — AI features are off in the user's settings.
   */
  kind: z.enum(['answer', 'boundary', 'support', 'disabled']),
  intent: z.enum(AGENT_INTENTS),
  answer: statementSchema,
  sections: z.array(statementSchema.extend({ kind: z.enum(SECTION_KINDS), title: z.string() })),
  suggestions: z.array(statementSchema),
  caveats: z.array(statementSchema),
  /** Which kinds of record the reply drew on, e.g. `meals:today`. */
  usedContext: z.array(z.string()),
  promptVersion: z.string().nullable(),
});

type Fits<Runtime, Schema> = Runtime extends Schema ? true : never;
const _contractFits: Fits<AgentChatResponse, z.infer<typeof agentChatResponseSchema>> = true;
void _contractFits;
