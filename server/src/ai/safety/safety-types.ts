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
   * The conversational categories (Task 8). Active only where a person is actually
   * talking to the app — never on a meal-logging field, where "đói chết đi được" means
   * "I'm hungry".
   */
  /** Asking for a diagnosis, a prescription or a dose, or describing an acute symptom. */
  | 'unsafe_health_request'
  /** Self-harm or suicidal intent. */
  | 'sensitive_crisis'
  /** Restriction, purging or compensation as something to do. */
  | 'unsafe_food_behavior';

/**
 * Categories that classify what a *person* says about themselves.
 *
 * Screened on the way in, never on the way out: a model reply that points someone towards
 * help necessarily mentions the thing it is helping with, and dropping it for that would
 * punish exactly the response the policy wants.
 */
export const PERSONAL_DISCLOSURE_CATEGORIES: readonly SafetyCategory[] = [
  'sensitive_crisis',
  'unsafe_health_request',
  'unsafe_food_behavior',
];

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
 * detector actually runs.
 *
 * The three conversational categories are active for `chat` only (Task 8): that is the
 * one surface where a person describes themselves in their own words, and where the
 * answer to a crisis or a request for a dose must be a person, not a model.
 *
 * `off_topic_misuse` is the purpose-scoped one: active for extraction, where a request
 * to write an essay is a misdirected call worth refusing before it costs anything, and
 * inactive for conversation, where it is just a thing someone said — the agent answers
 * it with a short boundary instead of a refusal.
 */
export const ACTIVE_CATEGORIES: Readonly<Record<AiPurpose, readonly SafetyCategory[]>> = {
  meal_parse: ['prompt_injection', 'off_topic_misuse'],
  meal_vision: ['prompt_injection', 'off_topic_misuse'],
  // No live surface yet. Injection screening is purpose-independent, so it applies.
  daily: ['prompt_injection'],
  weekly: ['prompt_injection'],
  pattern: ['prompt_injection'],
  chat: ['sensitive_crisis', 'unsafe_food_behavior', 'unsafe_health_request', 'prompt_injection'],
  plan: ['prompt_injection'],
};

export function isActive(purpose: AiPurpose, category: SafetyCategory): boolean {
  return ACTIVE_CATEGORIES[purpose].includes(category);
}

/**
 * What is screened in *model-authored* text: the input policy, minus the categories that
 * describe a person rather than an instruction (`PERSONAL_DISCLOSURE_CATEGORIES`).
 */
export function outputCategories(purpose: AiPurpose): readonly SafetyCategory[] {
  return ACTIVE_CATEGORIES[purpose].filter(
    (category) => !PERSONAL_DISCLOSURE_CATEGORIES.includes(category),
  );
}
