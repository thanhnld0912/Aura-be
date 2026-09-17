import { screenInput } from '../../ai/safety/index.js';
import type { AgentReplyGenerator } from '../../agent/agent-generator.js';
import { AGENT_CHAT_PROMPT_VERSION, type AgentReplyBody } from '../../agent/agent-reply.js';
import { classifyIntent, type AgentIntent } from '../../agent/intent.js';
import { disabledReply, safetyReply } from '../../agent/safety-responses.js';
import { ProviderUnavailableError } from '../../lib/errors.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import type { UsersService } from '../users/users.service.js';
import type { AgentContextBuilder } from './agent-context.js';

/**
 * `POST /api/agent/chat`: one message in, one validated reply out.
 *
 * ```
 * message → screenInput(chat) ──blocked──→ fixed reply (no model call, blocked ledger row)
 *        → AI opt-out?        ──yes──────→ fixed reply
 *        → classifyIntent → AgentContextBuilder (authorised reads, evidence)
 *        → AgentReplyGenerator → AiService → Claude → schema + evidence checks
 *        → reply
 * ```
 *
 * **Stateless.** Each message stands alone: no conversation table, no history sent to the
 * model, no memory written. A follow-up that depends on the previous turn gets an answer
 * that says what it lacks. Persistence and bounded history are future work, and choosing
 * to build neither yet is what keeps this task free of a migration.
 */

export type AgentReplyKind = AgentReplyBody['kind'] | 'support' | 'disabled';

export interface AgentChatResponse extends Omit<AgentReplyBody, 'kind'> {
  kind: AgentReplyKind;
  intent: AgentIntent;
  usedContext: string[];
  /** The prompt the model answered under; `null` when no model was asked. */
  promptVersion: string | null;
}

export interface AgentServiceDeps {
  users: Pick<UsersService, 'getProfile'>;
  context: Pick<AgentContextBuilder, 'build'>;
  /** Absent without an Anthropic key; answering then needs a model and is a `503`. */
  generator?: AgentReplyGenerator | undefined;
}

function fixedReply(kind: AgentReplyKind, text: string): AgentChatResponse {
  return {
    kind,
    intent: 'general',
    answer: { text, evidence: [] },
    sections: [],
    suggestions: [],
    caveats: [],
    usedContext: [],
    promptVersion: null,
  };
}

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  async chat(user: AuthenticatedUser, message: string): Promise<AgentChatResponse> {
    const profile = await this.deps.users.getProfile(user.id);
    const locale = profile.user.locale;
    const aiEnabled = profile.preferences.aiInsightsEnabled;

    // First, before any setting and any read: a person in crisis gets the supportive reply
    // whether or not AI features are on, and no record of theirs is loaded for it.
    const decision = screenInput(message, 'chat');
    if (decision.action === 'block') {
      if (aiEnabled && this.deps.generator) {
        await this.deps.generator.recordBlocked({ userId: user.id, messageChars: message.length });
      }
      const reply = safetyReply(decision.reason, locale);
      return fixedReply(reply.kind, reply.text);
    }

    if (!aiEnabled) return fixedReply('disabled', disabledReply(locale));

    if (!this.deps.generator) {
      throw new ProviderUnavailableError('The assistant is not available right now');
    }

    const classification = classifyIntent(message);
    const reader = {
      locale,
      goalFocus: profile.preferences.goalFocus,
      showCalories: profile.preferences.showCalories,
    };
    const context = await this.deps.context.build(user, reader, classification);

    const reply = await this.deps.generator.reply({
      userId: user.id,
      message,
      context: {
        language: locale,
        goalFocus: reader.goalFocus,
        showsCalories: reader.showCalories,
        intent: classification.intent,
        period: context.period,
        items: context.items,
      },
    });

    return {
      ...reply,
      intent: classification.intent,
      usedContext: context.usedContext,
      promptVersion: AGENT_CHAT_PROMPT_VERSION,
    };
  }
}
