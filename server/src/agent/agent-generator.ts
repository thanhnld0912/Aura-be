import type { AiService } from '../ai/ai.service.js';
import {
  agentReplyJsonSchema,
  agentReplySchemaFor,
  AGENT_CHAT_PROMPT_VERSION,
  AGENT_SYSTEM_PROMPT,
  buildAgentUserMessage,
  toAgentReply,
  type AgentModelContext,
  type AgentReplyBody,
} from './agent-reply.js';

/**
 * Answers a chat message with Claude, through `AiService`.
 *
 * ```
 * AgentService → AgentReplyGenerator → AiService (purpose chat) → ClaudeProvider
 * ```
 *
 * The model has **no tools**. It cannot read the database, call an endpoint or fetch a
 * URL; it receives statements the server already chose and returns JSON the server then
 * validates. A future function-calling design would replace `AgentContextBuilder`'s
 * deterministic selection, not this class — and it is deliberately not built.
 *
 * No fallback answer: a reply that cannot be validated is an error, not a template.
 */

/** Per attempt. An interactive reply; with the one retry, about a minute in the worst case. */
export const AGENT_CHAT_TIMEOUT_MS = 30_000;

/** Enough for a short answer and a few sections in Vietnamese; the schema caps the rest. */
export const AGENT_CHAT_MAX_TOKENS = 1_500;

export interface AgentReplyGenerator {
  readonly name: string;
  reply(input: { userId: string; message: string; context: AgentModelContext }): Promise<AgentReplyBody>;
  /** A ledger row for a message the safety gate stopped. Length only — never the text. */
  recordBlocked(input: { userId: string; messageChars: number }): Promise<void>;
}

export interface ClaudeAgentReplyGeneratorDeps {
  ai: AiService;
  /** `env.AI_MODEL_REASONING`. */
  model: string;
  /** Overridden only by tests. */
  timeoutMs?: number;
}

export class ClaudeAgentReplyGenerator implements AgentReplyGenerator {
  readonly name = 'claude-agent-v1';

  constructor(private readonly deps: ClaudeAgentReplyGeneratorDeps) {}

  async reply(input: { userId: string; message: string; context: AgentModelContext }): Promise<AgentReplyBody> {
    if (!input.userId) {
      throw new Error('ClaudeAgentReplyGenerator requires the authenticated user id to meter its calls');
    }

    const result = await this.deps.ai.run({
      userId: input.userId,
      purpose: 'chat',
      provider: 'anthropic',
      model: this.deps.model,
      schema: agentReplySchemaFor(input.context.items),
      system: AGENT_SYSTEM_PROMPT,
      user: buildAgentUserMessage(input.message, input.context),
      jsonSchema: agentReplyJsonSchema,
      maxTokens: AGENT_CHAT_MAX_TOKENS,
      timeoutMs: this.deps.timeoutMs ?? AGENT_CHAT_TIMEOUT_MS,
      // Shape only: the prompt version, and the length of the person's message rather
      // than of the whole prompt. No text, no context, no figures.
      meta: { promptVersion: AGENT_CHAT_PROMPT_VERSION, inputChars: input.message.length },
    });

    return toAgentReply(result.value, input.context.items);
  }

  async recordBlocked(input: { userId: string; messageChars: number }): Promise<void> {
    await this.deps.ai.recordBlocked({
      userId: input.userId,
      purpose: 'chat',
      provider: 'anthropic',
      model: this.deps.model,
      schema: agentReplySchemaFor([]),
      system: AGENT_SYSTEM_PROMPT,
      // Deliberately empty: the ledger records that a block happened and how long the
      // message was, and nothing that could reconstruct what someone said.
      user: '',
      meta: { promptVersion: AGENT_CHAT_PROMPT_VERSION, inputChars: input.messageChars },
    });
  }
}
