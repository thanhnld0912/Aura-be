import type { AiProvider } from './ai-provider.js';
import { AiProviderFailure, type AiCompletion, type AiProviderName, type AiRequest } from '../types.js';

/**
 * A provider that does exactly what a test tells it to.
 *
 * This is the only provider in the tree until Task 3, and it is what keeps the promise
 * that the suite runs with no API key: `AiService`'s retry, metering and validation are
 * all exercised against scripted outcomes rather than against a vendor.
 *
 * It is a *test double*, not a stub with opinions — it holds a queue of outcomes and
 * pops one per call, so a test can say "fail, then succeed" and assert on both rows the
 * ledger should now contain.
 */

export type FakeOutcome =
  | { type: 'ok'; output: unknown; usage?: AiCompletion['usage'] }
  | { type: 'fail'; failure: AiProviderFailure }
  /** Never settles on its own — resolves only when the caller's signal aborts. */
  | { type: 'hang' };

export interface FakeAiProviderOptions {
  name?: AiProviderName;
  outcomes: FakeOutcome[];
  /** Reported on every completion; the service copies it into the ledger. */
  model?: string;
}

export class FakeAiProvider implements AiProvider {
  readonly name: AiProviderName;
  /** Every request the service made, in order. Tests assert on `.length` for the cap. */
  readonly calls: AiRequest[] = [];

  private readonly outcomes: FakeOutcome[];

  constructor(options: FakeAiProviderOptions) {
    this.name = options.name ?? 'anthropic';
    this.outcomes = [...options.outcomes];
  }

  async complete(request: AiRequest, signal: AbortSignal): Promise<AiCompletion> {
    this.calls.push(request);

    const outcome = this.outcomes.shift();
    if (!outcome) {
      // Louder than returning a default: a test that drives more calls than it scripted
      // has found a retry loop, and that should fail as a bug rather than pass quietly.
      throw new Error(`FakeAiProvider ran out of outcomes on call ${this.calls.length}`);
    }

    if (outcome.type === 'hang') {
      // Mirrors a real provider: the abort is what ends the call, so the service's
      // timeout path is exercised rather than simulated.
      return new Promise<AiCompletion>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new AiProviderFailure('timeout', 'aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(new AiProviderFailure('timeout', 'aborted')),
          { once: true },
        );
      });
    }

    if (outcome.type === 'fail') throw outcome.failure;

    return {
      output: outcome.output,
      provider: this.name,
      model: request.model,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
  }
}

/** Shorthands, so a test reads as the scenario it is describing. */
export const fakeOutcomes = {
  ok: (output: unknown, usage?: AiCompletion['usage']): FakeOutcome => ({
    type: 'ok',
    ...(usage ? { usage } : {}),
    output,
  }),
  rateLimited: (retryAfterMs = 10): FakeOutcome => ({
    type: 'fail',
    failure: new AiProviderFailure('provider_error', 'rate limited', {
      status: 429,
      retryAfterMs,
    }),
  }),
  serverError: (status = 503): FakeOutcome => ({
    type: 'fail',
    failure: new AiProviderFailure('provider_error', 'upstream failed', { status }),
  }),
  /** No status: a socket that never became an HTTP response. */
  connectionError: (): FakeOutcome => ({
    type: 'fail',
    failure: new AiProviderFailure('provider_error', 'connection reset'),
  }),
  badRequest: (status: 400 | 401 = 400): FakeOutcome => ({
    type: 'fail',
    failure: new AiProviderFailure('provider_error', 'rejected', { status }),
  }),
  refused: (code = 'safety'): FakeOutcome => ({
    type: 'fail',
    failure: new AiProviderFailure('refused', 'the model declined', { code }),
  }),
  timeout: (): FakeOutcome => ({ type: 'hang' }),
} as const;
