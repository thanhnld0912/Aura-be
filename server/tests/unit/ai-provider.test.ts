import { describe, expect, it } from 'vitest';
import {
  FakeAiProvider,
  fakeOutcomes,
  type FakeOutcome,
} from '../../src/ai/providers/fake-provider.js';
import { AiProviderFailure, isAiProviderFailure, type AiRequest } from '../../src/ai/types.js';

/**
 * The test double itself.
 *
 * Worth its own tests for one reason: every `AiService` assertion is only as
 * trustworthy as this provider's behaviour. If "timeout" quietly resolved, or the
 * outcome queue silently repeated its last entry, the retry tests would pass while
 * proving nothing.
 */

const request: AiRequest = {
  model: 'test-model-1',
  system: 'system',
  user: 'user',
  maxTokens: 256,
  timeoutMs: 50,
  jsonSchema: {},
};

const never = new AbortController().signal;

describe('FakeAiProvider', () => {
  it('returns the scripted output, tagged with its own name and the requested model', async () => {
    const provider = new FakeAiProvider({ outcomes: [fakeOutcomes.ok({ a: 1 })] });

    const completion = await provider.complete(request, never);

    expect(completion.output).toEqual({ a: 1 });
    expect(completion.provider).toBe('anthropic');
    expect(completion.model).toBe('test-model-1');
    expect(completion.usage).toBeUndefined();
  });

  it('reports usage when the outcome carries it', async () => {
    const provider = new FakeAiProvider({
      outcomes: [fakeOutcomes.ok({ a: 1 }, { inputTokens: 7, outputTokens: 3 })],
    });

    const completion = await provider.complete(request, never);

    expect(completion.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('can be named as a different vendor', async () => {
    const provider = new FakeAiProvider({ name: 'google', outcomes: [fakeOutcomes.ok({})] });

    expect(provider.name).toBe('google');
    expect((await provider.complete(request, never)).provider).toBe('google');
  });

  it('records every request it was given, in order', async () => {
    const provider = new FakeAiProvider({
      outcomes: [fakeOutcomes.ok({}), fakeOutcomes.ok({})],
    });

    await provider.complete(request, never);
    await provider.complete({ ...request, user: 'second' }, never);

    expect(provider.calls.map((call) => call.user)).toEqual(['user', 'second']);
  });

  it('consumes outcomes one per call rather than repeating the last', async () => {
    const provider = new FakeAiProvider({
      outcomes: [fakeOutcomes.ok({ first: true }), fakeOutcomes.ok({ second: true })],
    });

    expect((await provider.complete(request, never)).output).toEqual({ first: true });
    expect((await provider.complete(request, never)).output).toEqual({ second: true });
  });

  it('throws rather than inventing an outcome when the script runs out', async () => {
    // This is what turns a runaway retry loop into a failing test instead of a slow one.
    const provider = new FakeAiProvider({ outcomes: [] });

    await expect(provider.complete(request, never)).rejects.toThrow(/ran out of outcomes/);
  });

  it('throws the scripted failure unchanged', async () => {
    const failure = new AiProviderFailure('provider_error', 'boom', { status: 500 });
    const provider = new FakeAiProvider({ outcomes: [{ type: 'fail', failure }] });

    await expect(provider.complete(request, never)).rejects.toBe(failure);
  });

  describe('the failure shorthands', () => {
    const cases: ReadonlyArray<[string, FakeOutcome, { kind: string; status?: number }]> = [
      ['rateLimited', fakeOutcomes.rateLimited(), { kind: 'provider_error', status: 429 }],
      ['serverError', fakeOutcomes.serverError(500), { kind: 'provider_error', status: 500 }],
      ['connectionError', fakeOutcomes.connectionError(), { kind: 'provider_error' }],
      ['badRequest', fakeOutcomes.badRequest(401), { kind: 'provider_error', status: 401 }],
      ['refused', fakeOutcomes.refused(), { kind: 'refused' }],
    ];

    for (const [label, outcome, expected] of cases) {
      it(`${label} produces a normalised AiProviderFailure`, async () => {
        const provider = new FakeAiProvider({ outcomes: [outcome] });

        const error = await provider.complete(request, never).catch((e: unknown) => e);

        expect(isAiProviderFailure(error)).toBe(true);
        const failure = error as AiProviderFailure;
        expect(failure.kind).toBe(expected.kind);
        expect(failure.status).toBe(expected.status);
      });
    }

    it('rateLimited carries a retry hint', () => {
      const outcome = fakeOutcomes.rateLimited(1234);
      expect(outcome.type).toBe('fail');
      if (outcome.type !== 'fail') throw new Error('unreachable');
      expect(outcome.failure.retryAfterMs).toBe(1234);
    });

    it('connectionError has no status, because there was no HTTP response', () => {
      const outcome = fakeOutcomes.connectionError();
      if (outcome.type !== 'fail') throw new Error('unreachable');
      expect(outcome.failure.status).toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('does not settle on its own', async () => {
      const provider = new FakeAiProvider({ outcomes: [fakeOutcomes.timeout()] });
      const controller = new AbortController();

      const settled = await Promise.race([
        provider.complete(request, controller.signal).then(() => 'settled').catch(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
      ]);

      expect(settled).toBe('pending');
      controller.abort();
    });

    it('rejects as a timeout once the caller aborts', async () => {
      const provider = new FakeAiProvider({ outcomes: [fakeOutcomes.timeout()] });
      const controller = new AbortController();

      const pending = provider.complete(request, controller.signal);
      controller.abort();

      const error = await pending.catch((e: unknown) => e);
      expect(isAiProviderFailure(error)).toBe(true);
      expect((error as AiProviderFailure).kind).toBe('timeout');
    });

    it('rejects immediately when handed an already-aborted signal', async () => {
      const provider = new FakeAiProvider({ outcomes: [fakeOutcomes.timeout()] });

      const error = await provider.complete(request, AbortSignal.abort()).catch((e: unknown) => e);

      expect((error as AiProviderFailure).kind).toBe('timeout');
    });
  });
});
