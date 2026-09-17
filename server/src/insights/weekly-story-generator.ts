import type { AiService } from '../ai/ai.service.js';
import { screenInput } from '../ai/safety/index.js';
import { ProviderError } from '../lib/errors.js';
import {
  buildWeeklyStoryUserMessage,
  evidenceForModel,
  toWeeklyStory,
  weeklyStoryJsonSchema,
  weeklyStorySchemaFor,
  WEEKLY_STORY_PROMPT_VERSION,
  WEEKLY_STORY_SYSTEM_PROMPT,
  type WeeklyEvidence,
  type WeeklyStory,
} from './weekly-story.js';

/**
 * Writes a weekly story with Claude.
 *
 * ```
 * InsightsService → WeeklyStoryGenerator → AiService → ClaudeProvider → Anthropic
 * ```
 *
 * It never touches the SDK: retries, the timeout, schema validation and the `ai_runs`
 * row all come from `AiService`. This class supplies a prompt, the evidence and a schema
 * bound to that evidence, and maps the validated result.
 *
 * ## What it deliberately does not do
 *
 * **No fallback narrative.** When Claude cannot produce a story that passes validation,
 * the error propagates. A templated paragraph standing in for a failed model call would
 * be a story nobody wrote dressed up as one somebody did — and the deterministic report
 * the story was built from stays available on its own endpoint regardless.
 */

/**
 * Per attempt. Reasoning over a week takes longer than extraction's 30 s
 * (AI_ARCHITECTURE.md §8), and an attempt aborted after it has been billed is the most
 * expensive kind of failure. Two attempts bound the request at roughly two minutes.
 */
export const WEEKLY_STORY_TIMEOUT_MS = 60_000;

/** The story is capped by its schema at a few short paragraphs; this leaves headroom for Vietnamese. */
export const WEEKLY_STORY_MAX_TOKENS = 3_000;

export interface WeeklyStoryGenerator {
  /** Domain-level identifier, not a vendor model id. */
  readonly name: string;
  generate(evidence: WeeklyEvidence, context: { userId: string }): Promise<WeeklyStory>;
}

export interface ClaudeWeeklyStoryGeneratorDeps {
  ai: AiService;
  /** `env.AI_MODEL_REASONING` — narrating someone's behaviour is reasoning, not extraction. */
  model: string;
  /** Overridden only by tests, so the suite does not wait out a real timeout. */
  timeoutMs?: number;
}

export class ClaudeWeeklyStoryGenerator implements WeeklyStoryGenerator {
  readonly name = 'claude-weekly-v1';

  constructor(private readonly deps: ClaudeWeeklyStoryGeneratorDeps) {}

  async generate(evidence: WeeklyEvidence, context: { userId: string }): Promise<WeeklyStory> {
    if (!context.userId) {
      throw new Error('ClaudeWeeklyStoryGenerator requires the authenticated user id to meter its calls');
    }

    const request = {
      userId: context.userId,
      purpose: 'weekly' as const,
      provider: 'anthropic' as const,
      model: this.deps.model,
      schema: weeklyStorySchemaFor(evidence),
      system: WEEKLY_STORY_SYSTEM_PROMPT,
      user: buildWeeklyStoryUserMessage(evidence),
      // Shape only. `AiService` adds the input length; nothing here carries a figure.
      meta: { promptVersion: WEEKLY_STORY_PROMPT_VERSION },
    };

    // The evidence is server-computed text, so this should never fire. It is here for
    // the day pattern labels come from a user-named habit: the same gate, the same
    // policy row (`weekly`), and a blocked row in the ledger rather than a silent call.
    if (screenInput(JSON.stringify(evidenceForModel(evidence)), 'weekly').action === 'block') {
      await this.deps.ai.recordBlocked(request);
      throw new ProviderError('ai', 'The weekly story could not be generated');
    }

    const result = await this.deps.ai.run({
      ...request,
      jsonSchema: weeklyStoryJsonSchema,
      maxTokens: WEEKLY_STORY_MAX_TOKENS,
      timeoutMs: this.deps.timeoutMs ?? WEEKLY_STORY_TIMEOUT_MS,
    });

    return toWeeklyStory(result.value, evidence);
  }
}
