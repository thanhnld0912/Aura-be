import { describe, expect, it, vi } from 'vitest';
import { AiService } from '../../src/ai/ai.service.js';
import type { AiRunRecorder, AiRunRow, RecordAiRunInput } from '../../src/ai/ai-runs.repository.js';
import { ClaudeProvider } from '../../src/ai/providers/claude-provider.js';
import { AiProviderFailure, isAiProviderFailure, type AiRequest } from '../../src/ai/types.js';
import { z } from 'zod';

/**
 * The Anthropic adapter (AI_ARCHITECTURE.md §4).
 *
 * These tests drive the **real SDK** over a fake `fetch`, rather than stubbing the
 * client. That costs a few lines of response-building and buys the thing actually worth
 * testing: the mapping is verified against the SDK's own exception hierarchy and its own
 * request serialisation, so an SDK upgrade that renames `RateLimitError` or moves
 * `output_config` fails here instead of in production.
 *
 * No test in this file reaches the network, and none requires `ANTHROPIC_API_KEY`.
 */

const API_KEY = 'test-key-not-a-real-credential';

const request: AiRequest = {
  model: 'claude-haiku-4-5',
  system: 'You extract structured data.',
  user: 'hai quả trứng và một bát phở',
  maxTokens: 1024,
  timeoutMs: 5_000,
  jsonSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
};

const never = new AbortController().signal;

/** A Messages API success body, in the shape the API actually returns. */
function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_01XxTest',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: '{"answer":"two eggs and a bowl of phở"}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 34 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** An Anthropic error body, which is what the SDK reads `type` out of. */
function errorResponse(status: number, type: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: 'upstream said no' } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function providerWith(fetchImpl: typeof fetch): ClaudeProvider {
  return new ClaudeProvider({ apiKey: API_KEY, fetchImpl });
}

/** Succeeds once with the given body. */
function okFetch(body: Record<string, unknown> = messageBody()) {
  return vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
}

/** The parsed request body the SDK actually put on the wire. */
function sentBody(fetchImpl: unknown): Record<string, unknown> {
  const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
  const call = mock.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('ClaudeProvider — construction', () => {
  it('refuses to construct without a key, rather than reading one from the ambient process', async () => {
    // The SDK's own fallback is `process.env.ANTHROPIC_API_KEY`. Silently inheriting it
    // would let the provider work wherever a developer happens to have a key exported
    // and fail wherever the parsed config does not carry one.
    expect(() => new ClaudeProvider({ apiKey: '' })).toThrow(/API key/);
  });

  it('uses the injected key even when the environment holds a different one', async () => {
    const previous = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'ambient-value-that-must-not-win';
    try {
      const fetchImpl = okFetch();
      await providerWith(fetchImpl).complete(request, never);

      const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
      const firstCall = mock.mock.calls[0];
      if (!firstCall) throw new Error('fetch was never called');
      const headers = new Headers((firstCall[1] as RequestInit).headers);
      expect(headers.get('x-api-key')).toBe(API_KEY);
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });
});

describe('ClaudeProvider — request mapping', () => {
  it('forwards the model, system prompt, user text and token cap', async () => {
    const fetchImpl = okFetch();
    await providerWith(fetchImpl).complete(request, never);

    const body = sentBody(fetchImpl);
    expect(body['model']).toBe('claude-haiku-4-5');
    expect(body['system']).toBe('You extract structured data.');
    expect(body['max_tokens']).toBe(1024);
    expect(body['messages']).toEqual([
      { role: 'user', content: 'hai quả trứng và một bát phở' },
    ]);
  });

  it('sends the caller JSON Schema as the structured-output format, unaltered', async () => {
    const fetchImpl = okFetch();
    await providerWith(fetchImpl).complete(request, never);

    expect(sentBody(fetchImpl)['output_config']).toEqual({
      format: { type: 'json_schema', schema: request.jsonSchema },
    });
  });

  it('omits output_config when the caller supplied no schema', async () => {
    const fetchImpl = okFetch();
    await providerWith(fetchImpl).complete({ ...request, jsonSchema: {} }, never);

    expect(sentBody(fetchImpl)).not.toHaveProperty('output_config');
  });

  it('sends no thinking or effort configuration', async () => {
    // Haiku 4.5 rejects both with a 400. The reasoning path's settings must never
    // arrive here by default (AI_ARCHITECTURE.md §4).
    const fetchImpl = okFetch();
    await providerWith(fetchImpl).complete(request, never);

    const body = sentBody(fetchImpl);
    expect(body).not.toHaveProperty('thinking');
    expect(body['output_config']).not.toHaveProperty('effort');
  });

  it('uses whatever model the request names, with no per-model branching', async () => {
    const fetchImpl = okFetch(messageBody({ model: 'claude-opus-5' }));
    const completion = await providerWith(fetchImpl).complete(
      { ...request, model: 'claude-opus-5' },
      never,
    );

    expect(sentBody(fetchImpl)['model']).toBe('claude-opus-5');
    // The model is reported back from the response, not echoed from the request.
    expect(completion.model).toBe('claude-opus-5');
  });

  it('authenticates with the configured key and never puts it in the URL', async () => {
    const fetchImpl = okFetch();
    await providerWith(fetchImpl).complete(request, never);

    const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
    const firstCall = mock.mock.calls[0];
    if (!firstCall) throw new Error('fetch was never called');
    const [url, init] = firstCall as [unknown, RequestInit];
    const headers = new Headers(init.headers);

    expect(headers.get('x-api-key')).toBe(API_KEY);
    // A key in a query string ends up in access logs and referrer headers.
    expect(String(url)).not.toContain(API_KEY);
  });
});

describe('ClaudeProvider — response extraction', () => {
  it('parses the structured JSON payload into an object', async () => {
    const completion = await providerWith(okFetch()).complete(request, never);

    expect(completion.output).toEqual({ answer: 'two eggs and a bowl of phở' });
    expect(completion.provider).toBe('anthropic');
  });

  it('skips non-text blocks rather than reading content[0] blindly', async () => {
    // With thinking enabled the answer is not the first block.
    const body = messageBody({
      content: [
        { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
        { type: 'text', text: '{"answer":"ok"}' },
      ],
    });

    const completion = await providerWith(okFetch(body)).complete(request, never);
    expect(completion.output).toEqual({ answer: 'ok' });
  });

  it('joins a payload split across several text blocks', async () => {
    const body = messageBody({
      content: [
        { type: 'text', text: '{"answer":' },
        { type: 'text', text: '"split"}' },
      ],
    });

    const completion = await providerWith(okFetch(body)).complete(request, never);
    expect(completion.output).toEqual({ answer: 'split' });
  });

  it('returns raw text when no schema was requested', async () => {
    const body = messageBody({ content: [{ type: 'text', text: 'just prose' }] });
    const completion = await providerWith(okFetch(body)).complete(
      { ...request, jsonSchema: {} },
      never,
    );

    expect(completion.output).toBe('just prose');
  });

  it('maps usage, and reports cache reads when the response has them', async () => {
    const body = messageBody({
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 512 },
    });

    const completion = await providerWith(okFetch(body)).complete(request, never);
    expect(completion.usage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      cacheReadInputTokens: 512,
    });
  });

  it('leaves cache reads absent rather than zero when caching was not used', async () => {
    // The distinction matters: 0 asserts "caching ran and missed", absent says "we do
    // not know". Only a real cache_read figure counts as caching observed (§17).
    const body = messageBody({
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: null },
    });

    const completion = await providerWith(okFetch(body)).complete(request, never);
    expect(completion.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(completion.usage).not.toHaveProperty('cacheReadInputTokens');
  });

  it('reports no usage at all when the response carried none', async () => {
    const body = messageBody({ usage: undefined });
    delete body['usage'];

    const completion = await providerWith(okFetch(body)).complete(request, never);
    expect(completion.usage).toBeUndefined();
  });
});

describe('ClaudeProvider — failure mapping', () => {
  async function failureFrom(fetchImpl: typeof fetch, req: AiRequest = request) {
    const error = await providerWith(fetchImpl)
      .complete(req, never)
      .catch((e: unknown) => e);
    expect(isAiProviderFailure(error)).toBe(true);
    return error as AiProviderFailure;
  }

  const httpCases: ReadonlyArray<[number, string]> = [
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [503, 'overloaded_error'],
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
  ];

  for (const [status, type] of httpCases) {
    it(`maps HTTP ${status} to a provider_error carrying the status`, async () => {
      const failure = await failureFrom(
        vi.fn(async () => errorResponse(status, type)) as unknown as typeof fetch,
      );

      expect(failure.kind).toBe('provider_error');
      expect(failure.status).toBe(status);
      // The status is what AiService's retry policy reads; the provider does not decide.
      expect(failure.code).toBe(type);
    });
  }

  it('passes a Retry-After header through as a retry hint', async () => {
    const failure = await failureFrom(
      vi.fn(async () =>
        errorResponse(429, 'rate_limit_error', { 'retry-after': '3' }),
      ) as unknown as typeof fetch,
    );

    expect(failure.retryAfterMs).toBe(3_000);
  });

  it('maps a connection failure to a statusless provider_error', async () => {
    const failure = await failureFrom(
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    );

    expect(failure.kind).toBe('provider_error');
    // No HTTP response happened, so there is no status to report — and AiService reads
    // that absence as "retryable".
    expect(failure.status).toBeUndefined();
  });

  it('maps caller cancellation to a timeout', async () => {
    const failure = await providerWith(okFetch())
      .complete(request, AbortSignal.abort())
      .catch((e: unknown) => e);

    expect(isAiProviderFailure(failure)).toBe(true);
    expect((failure as AiProviderFailure).kind).toBe('timeout');
  });

  it('maps an explicit refusal to refused, keeping only the policy category', async () => {
    const body = messageBody({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: 'echoes the user text' },
    });

    const failure = await failureFrom(okFetch(body));
    expect(failure.kind).toBe('refused');
    expect(failure.code).toBe('general_harms');
    // The free-prose explanation can quote the request, so it is dropped.
    expect(JSON.stringify(failure)).not.toContain('echoes the user text');
  });

  it('maps a non-JSON payload to a provider_error', async () => {
    const body = messageBody({ content: [{ type: 'text', text: 'Sure! Here is the JSON:' }] });

    const failure = await failureFrom(okFetch(body));
    expect(failure.kind).toBe('provider_error');
    expect(failure.status).toBeUndefined();
  });

  it('maps an empty response to a provider_error naming the stop reason', async () => {
    const body = messageBody({ content: [], stop_reason: 'max_tokens' });

    const failure = await failureFrom(okFetch(body));
    expect(failure.kind).toBe('provider_error');
    expect(failure.code).toBe('max_tokens');
  });
});

describe('ClaudeProvider — the SDK must not retry', () => {
  it('makes exactly one HTTP call on a 429', async () => {
    // The SDK retries twice by default, and 429 is squarely in its retry set. If
    // maxRetries: 0 were ever dropped, AiService's two-call budget would quietly become
    // six calls and six times the bill — so this asserts on the call count.
    const fetchImpl = vi.fn(async () => errorResponse(429, 'rate_limit_error'));

    await providerWith(fetchImpl as unknown as typeof fetch)
      .complete(request, never)
      .catch(() => undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one HTTP call on a 500', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(500, 'api_error'));

    await providerWith(fetchImpl as unknown as typeof fetch)
      .complete(request, never)
      .catch(() => undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeProvider — what a failure may not carry', () => {
  /** Runs the provider expecting rejection, and hands back the normalised failure. */
  async function rejection(status: number, type: string): Promise<AiProviderFailure> {
    const thrown = await providerWith(
      vi.fn(async () => errorResponse(status, type)) as unknown as typeof fetch,
    )
      .complete(request, never)
      .then(() => undefined)
      .catch((e: unknown) => e);

    if (!isAiProviderFailure(thrown)) throw new Error('expected an AiProviderFailure');
    return thrown;
  }

  it('never exposes the API key or the authorization header', async () => {
    const failure = await rejection(401, 'authentication_error');

    // The whole object, including `cause`, has to be clean — anything reachable from the
    // thrown value could reach a log.
    const dump = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
    expect(dump).not.toContain(API_KEY);
    expect(dump.toLowerCase()).not.toContain('x-api-key');
  });

  it('never repeats the provider message or the user text', async () => {
    const failure = await rejection(400, 'invalid_request_error');

    // `message` is what a careless logger prints first.
    expect(failure.message).not.toContain('upstream said no');
    expect(failure.message).not.toContain('trứng');
  });
});

/**
 * §25 — the seam itself.
 *
 * Two cases, both through the real `AiService` and the real `ClaudeProvider`, proving
 * the layers still divide the way Task 2 arranged them: the service validates and the
 * service decides how many calls happen.
 */
describe('AiService → ClaudeProvider', () => {
  const schema = z.object({ answer: z.string() }).strict();

  function recorder(): AiRunRecorder & { rows: RecordAiRunInput[] } {
    const rows: RecordAiRunInput[] = [];
    return {
      rows,
      async record(input) {
        rows.push(input);
        return { id: `run-${rows.length}`, ...input } as unknown as AiRunRow;
      },
    };
  }

  function service(fetchImpl: typeof fetch, runs: AiRunRecorder) {
    return new AiService({
      providers: [new ClaudeProvider({ apiKey: API_KEY, fetchImpl })],
      runs,
      sleep: async () => {},
    });
  }

  const call = {
    userId: '00000000-0000-4000-8000-000000000001',
    purpose: 'meal_parse' as const,
    provider: 'anthropic' as const,
    model: 'claude-haiku-4-5',
    system: 'extract',
    user: 'hai quả trứng',
    jsonSchema: request.jsonSchema,
  };

  it('validates a Claude response with the caller schema and meters the call', async () => {
    const runs = recorder();
    const result = await service(okFetch(), runs).run({ ...call, schema });

    expect(result.value).toEqual({ answer: 'two eggs and a bowl of phở' });
    expect(result.attempts).toBe(1);

    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      status: 'ok',
      inputTokens: 120,
      outputTokens: 34,
    });
  });

  it('retries a 429 exactly once, because the service — not the SDK — owns the budget', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, 'rate_limit_error', { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(messageBody()));

    const runs = recorder();
    const result = await service(fetchImpl as unknown as typeof fetch, runs).run({
      ...call,
      schema,
    });

    expect(result.attempts).toBe(2);
    // Two HTTP calls total: one per service attempt, none from the SDK.
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The failed attempt stays in the ledger rather than being overwritten.
    expect(runs.rows.map((row) => row.status)).toEqual(['provider_error', 'ok']);
    expect(runs.rows.map((row) => row.attempt)).toEqual([1, 2]);
  });

  it('stops after two provider calls when Claude keeps failing', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(503, 'overloaded_error'));
    const runs = recorder();

    await expect(
      service(fetchImpl as unknown as typeof fetch, runs).run({ ...call, schema }),
    ).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(runs.rows).toHaveLength(2);
  });

  it('rejects a well-formed response that does not match the caller schema', async () => {
    // Structured output constrains the shape; it does not make the schema redundant.
    const body = messageBody({ content: [{ type: 'text', text: '{"answer":42}' }] });
    const runs = recorder();

    await expect(
      service(okFetch(body), runs).run({ ...call, schema }),
    ).rejects.toMatchObject({ code: 'AI_SCHEMA_ERROR' });

    expect(runs.rows.map((row) => row.status)).toEqual(['schema_error', 'schema_error']);
  });

  it('severs the vendor exception before the error leaves the service', async () => {
    // `AiProviderFailure` keeps the SDK error as `cause`, which is worth having while
    // debugging — but Anthropic's 400 bodies can quote the request back, so the chain
    // must not survive into anything Fastify logs or serialises. AiService builds a
    // fresh AppError, and this asserts that the link is genuinely gone.
    const runs = recorder();
    const thrown = await service(
      vi.fn(async () => errorResponse(400, 'invalid_request_error')) as unknown as typeof fetch,
      runs,
    )
      .run({ ...call, schema })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { cause?: unknown };
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('upstream said no');

    // And the ledger kept only the classification.
    expect(runs.rows[0]?.error).toBe('provider_error status 400 invalid_request_error');
  });

  it('never lets the user text or the prompt reach the ledger', async () => {
    const runs = recorder();
    await service(okFetch(), runs).run({ ...call, schema });

    const dump = JSON.stringify(runs.rows);
    expect(dump).not.toContain('hai quả trứng');
    expect(dump).not.toContain('extract');
    expect(dump).not.toContain(API_KEY);
  });
});
