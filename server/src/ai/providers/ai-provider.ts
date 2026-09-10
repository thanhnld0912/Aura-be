import type { AiCompletion, AiProviderName, AiRequest } from '../types.js';

/**
 * A vendor adapter, and nothing else.
 *
 * Shaped after `NutritionProvider` (`src/nutrition/types.ts`) for the same reasons: a
 * narrow interface, a `name` the registry keys on, construction-time configuration,
 * and an injected transport so tests need no network. The resemblance is deliberate —
 * a second provider pattern in one codebase is a second thing to learn.
 *
 * An implementation may do exactly one thing: turn an `AiRequest` into an
 * `AiCompletion`, or throw an `AiProviderFailure`. It must not validate against a
 * domain schema, write `ai_runs`, build prompts, retry, or know that meals exist.
 * Everything above this line is `AiService`'s.
 */
export interface AiProvider {
  readonly name: AiProviderName;
  /**
   * One attempt. No internal retries — `AiService` owns the retry budget, and an SDK
   * quietly retrying underneath it would turn a two-call policy into a six-call one.
   * Real providers must therefore be constructed with their SDK retries disabled.
   */
  complete(request: AiRequest, signal: AbortSignal): Promise<AiCompletion>;
}
