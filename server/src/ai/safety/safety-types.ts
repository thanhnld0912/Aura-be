import type { AiPurpose } from '../types.js';

/**
 * The vocabulary of the safety layer.
 *
 * Two ideas carry most of the weight here.
 *
 * **A category is not a policy.** A category names a kind of risk; whether it is screened
 * for depends on the purpose of the call. "Write me a poem" is misuse in a meal parser
 * and an ordinary request in a chat, so the same text has different verdicts depending on
 * where it arrives. `ACTIVE_CATEGORIES` is the whole policy, in one readable table.
 *
 * **A block reason is internal.** The category tells the *server* why something stopped.
 * It is never returned to a client and never written to `ai_runs` — a stored reason is a
 * stored claim about a person, which is exactly what a health app should not accumulate.
 */

export type SafetyCategory =
  /** Text trying to act as instructions rather than as content. */
  | 'prompt_injection'
  /** A request the surface is not for, e.g. asking a meal parser to write an essay. */
  | 'off_topic_misuse'
  /**
   * Reserved for the conversational surfaces, with no detector in this task. Broad
   * health screening belongs where a person is actually talking to the app (Task 8),
   * not on a meal-logging field where "đói chết đi được" means "I'm hungry".
   */
  | 'unsafe_health_request'
  | 'sensitive_crisis'
  | 'unsafe_food_behavior';

export type SafetyDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: SafetyCategory };

export const ALLOW: SafetyDecision = { action: 'allow' };

export function block(reason: SafetyCategory): SafetyDecision {
  return { action: 'block', reason };
}

/**
 * Which categories are screened for, per purpose.
 *
 * Deliberately narrow, and deliberately honest: a category is listed only where a
 * detector actually runs. `sensitive_crisis`, `unsafe_health_request` and
 * `unsafe_food_behavior` appear in no row, because no detector for them exists yet.
 * Listing them here would make this table a description of an intention rather than of
 * the code.
 *
 * `off_topic_misuse` is the purpose-scoped one: active for extraction, where a request
 * to write an essay is a misdirected call worth refusing before it costs anything, and
 * inactive for conversation, where it is just a thing someone said.
 */
export const ACTIVE_CATEGORIES: Readonly<Record<AiPurpose, readonly SafetyCategory[]>> = {
  meal_parse: ['prompt_injection', 'off_topic_misuse'],
  meal_vision: ['prompt_injection', 'off_topic_misuse'],
  // No live surface yet. Injection screening is purpose-independent, so it applies;
  // the health categories wait for the Agent layer to define their policy.
  daily: ['prompt_injection'],
  weekly: ['prompt_injection'],
  pattern: ['prompt_injection'],
  chat: ['prompt_injection'],
  plan: ['prompt_injection'],
};

export function isActive(purpose: AiPurpose, category: SafetyCategory): boolean {
  return ACTIVE_CATEGORIES[purpose].includes(category);
}
