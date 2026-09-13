import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import { AiService } from '../../src/ai/ai.service.js';
import type { AiRunRecorder, AiRunRow, RecordAiRunInput } from '../../src/ai/ai-runs.repository.js';
import { estimateCost } from '../../src/ai/pricing.js';
import { GeminiProvider, toGeminiJsonSchema } from '../../src/ai/providers/gemini-provider.js';
import { isAiProviderFailure, type AiProviderFailure, type AiRequest } from '../../src/ai/types.js';

/**
 * The Gemini adapter (AI_ARCHITECTURE.md §2).
 *
 * As with the Claude adapter, these drive the **real SDK** — here over a stubbed global
 * `fetch`, which is what `@google/genai` calls. That tests the SDK's own request building
 * and its own error types rather than imitations of them, so an SDK upgrade that moves a
 * field fails here instead of in production.
 *
 * No test reaches the network, and none needs `GEMINI_API_KEY`.
 */

const API_KEY = 'test-gemini-key-not-a-real-credential';
const MODEL = 'gemini-2.5-flash';
const IMAGE = Buffer.from('re-encoded-webp-bytes-for-transport');

const request: AiRequest = {
  model: MODEL,
  system: 'You identify food in photos.',
  user: 'Identify the foods in the attached meal photo.',
  maxTokens: 1024,
  timeoutMs: 5_000,
  jsonSchema: {
    type: 'object',
    properties: { answer: { type: 'string', minLength: 1, maxLength: 50 } },
    required: ['answer'],
    additionalProperties: false,
  },
  image: { mimeType: 'image/webp', data: IMAGE },
};

const never = new AbortController().signal;

type FetchImpl = (input: unknown, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchImpl): Mock<FetchImpl> {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `generateContent` success body, in the shape the REST API returns it. */
function geminiBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: '{"answer":"cơm tấm"}' }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 1290, candidatesTokenCount: 40, totalTokenCount: 1330 },
    modelVersion: MODEL,
    responseId: 'resp-test',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Google error body, whose message deliberately echoes user text. */
function googleError(status: number, label: string): Response {
  return jsonResponse(
    { error: { code: status, message: 'upstream detail quoting cơm tấm back', status: label } },
    status,
  );
}

const ok = (body: Record<string, unknown> = geminiBody()) => stubFetch(async () => jsonResponse(body));

interface SentBody {
  contents: Array<{
    role?: string;
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }>;
  systemInstruction?: unknown;
  generationConfig?: {
    responseMimeType?: string;
    responseJsonSchema?: Record<string, unknown>;
    maxOutputTokens?: number;
  };
}

function sent(mock: Mock<FetchImpl>): { url: string; headers: Headers; body: SentBody } {
  const call = mock.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  const [input, init] = call;
  return {
    url: String(input),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)) as SentBody,
  };
}

async function failureFrom(pending: Promise<unknown>): Promise<AiProviderFailure> {
  const thrown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!isAiProviderFailure(thrown)) throw new Error('expected an AiProviderFailure');
  return thrown;
}

const provider = () => new GeminiProvider({ apiKey: API_KEY });

describe('GeminiProvider — construction', () => {
  it('refuses to construct without a key rather than reading one from the environment', () => {
    expect(() => new GeminiProvider({ apiKey: '' })).toThrow(/API key/);
  });

  it('uses the injected key even when the environment holds a different one', async () => {
    const saved = { gemini: process.env['GEMINI_API_KEY'], google: process.env['GOOGLE_API_KEY'] };
    process.env['GEMINI_API_KEY'] = 'ambient-gemini-value-that-must-not-win';
    process.env['GOOGLE_API_KEY'] = 'ambient-google-value-that-must-not-win';
    try {
      const fetchMock = ok();
      await provider().complete(request, never);
      expect(sent(fetchMock).headers.get('x-goog-api-key')).toBe(API_KEY);
    } finally {
      for (const [name, value] of [
        ['GEMINI_API_KEY', saved.gemini],
        ['GOOGLE_API_KEY', saved.google],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('GeminiProvider — request mapping', () => {
  it('calls generateContent on the requested model, with the key in a header only', async () => {
    const fetchMock = ok();
    await provider().complete(request, never);

    const { url, headers } = sent(fetchMock);
    expect(url).toContain(`models/${MODEL}:generateContent`);
    expect(headers.get('x-goog-api-key')).toBe(API_KEY);
    // A key in a URL ends up in access logs.
    expect(url).not.toContain(API_KEY);
  });

  it('sends the text first and the image as inline base64 beside it', async () => {
    const fetchMock = ok();
    await provider().complete(request, never);

    const parts = sent(fetchMock).body.contents[0]?.parts ?? [];
    expect(parts[0]?.text).toBe(request.user);
    expect(parts[1]?.inlineData).toEqual({
      mimeType: 'image/webp',
      data: IMAGE.toString('base64'),
    });
  });

  it('sends a text-only request as a single part', async () => {
    const fetchMock = ok();
    const { image: _image, ...textOnly } = request;
    await provider().complete(textOnly, never);

    expect(sent(fetchMock).body.contents[0]?.parts).toEqual([{ text: request.user }]);
  });

  it('carries the system prompt as a system instruction, never inside the user content', async () => {
    const fetchMock = ok();
    await provider().complete(request, never);

    const { body } = sent(fetchMock);
    expect(JSON.stringify(body.systemInstruction)).toContain(request.system);
    expect(JSON.stringify(body.contents)).not.toContain(request.system);
  });

  it('requests JSON constrained by the schema, narrowed to the keywords Gemini accepts', async () => {
    const fetchMock = ok();
    await provider().complete(request, never);

    const config = sent(fetchMock).body.generationConfig;
    expect(config?.responseMimeType).toBe('application/json');
    expect(config?.maxOutputTokens).toBe(1024);
    expect(config?.responseJsonSchema).toEqual({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    });
  });

  it('omits the JSON configuration when no schema was supplied', async () => {
    const fetchMock = ok(geminiBody({ candidates: [{ content: { parts: [{ text: 'prose' }] } }] }));
    await provider().complete({ ...request, jsonSchema: {} }, never);

    const config = sent(fetchMock).body.generationConfig;
    expect(config?.responseMimeType).toBeUndefined();
    expect(config?.responseJsonSchema).toBeUndefined();
  });

  it('sends no thinking configuration', async () => {
    // Thinking controls differ between Gemini generations; a value chosen for one model
    // is a 400 on another, so the adapter stays out of it.
    const fetchMock = ok();
    await provider().complete(request, never);

    expect(JSON.stringify(sent(fetchMock).body)).not.toContain('thinking');
  });
});

describe('GeminiProvider — response extraction', () => {
  it('parses the structured payload and reports the model that answered', async () => {
    ok();
    const completion = await provider().complete(request, never);

    expect(completion.output).toEqual({ answer: 'cơm tấm' });
    expect(completion.provider).toBe('google');
    expect(completion.model).toBe(MODEL);
  });

  it('falls back to the requested model when the response names none', async () => {
    const body = geminiBody();
    delete body['modelVersion'];
    ok(body);

    expect((await provider().complete(request, never)).model).toBe(MODEL);
  });

  it('ignores thought parts and joins the remaining text parts', async () => {
    ok(
      geminiBody({
        candidates: [
          {
            content: {
              parts: [
                { text: 'internal reasoning about the plate', thought: true },
                { text: '{"answer":' },
                { text: '"phở"}' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    );

    expect((await provider().complete(request, never)).output).toEqual({ answer: 'phở' });
  });

  it('returns raw text when no schema was requested', async () => {
    ok(geminiBody({ candidates: [{ content: { parts: [{ text: 'just prose' }] } }] }));
    const completion = await provider().complete({ ...request, jsonSchema: {} }, never);
    expect(completion.output).toBe('just prose');
  });

  it('reports uncached input, output including thoughts, and cache reads separately', async () => {
    // Gemini's promptTokenCount *includes* cached tokens and bills thoughts as output.
    // AURA's accounting prices uncached input and cache reads apart, so the cached share
    // is subtracted — otherwise it would be billed twice.
    ok(
      geminiBody({
        usageMetadata: {
          promptTokenCount: 1290,
          cachedContentTokenCount: 1000,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 25,
          totalTokenCount: 1355,
        },
      }),
    );

    expect((await provider().complete(request, never)).usage).toEqual({
      inputTokens: 290,
      outputTokens: 65,
      cacheReadInputTokens: 1000,
    });
  });

  it('leaves cache reads absent rather than zero when none were reported', async () => {
    ok();
    const usage = (await provider().complete(request, never)).usage;
    expect(usage).toEqual({ inputTokens: 1290, outputTokens: 40 });
    expect(usage).not.toHaveProperty('cacheReadInputTokens');
  });

  it('reports no usage at all when the response carried none', async () => {
    const body = geminiBody();
    delete body['usageMetadata'];
    ok(body);

    expect((await provider().complete(request, never)).usage).toBeUndefined();
  });
});

describe('GeminiProvider — failure mapping', () => {
  const httpCases: ReadonlyArray<[number, string]> = [
    [429, 'RESOURCE_EXHAUSTED'],
    [500, 'INTERNAL'],
    [503, 'UNAVAILABLE'],
    [400, 'INVALID_ARGUMENT'],
    [401, 'UNAUTHENTICATED'],
    [403, 'PERMISSION_DENIED'],
  ];

  for (const [status, label] of httpCases) {
    it(`maps HTTP ${status} to a provider_error carrying the status and Google's label`, async () => {
      stubFetch(async () => googleError(status, label));

      const failure = await failureFrom(provider().complete(request, never));

      expect(failure.kind).toBe('provider_error');
      // The status is what AiService's policy reads; the adapter decides nothing.
      expect(failure.status).toBe(status);
      expect(failure.code).toBe(label);
    });
  }

  it('maps a connection failure to a statusless provider_error', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const failure = await failureFrom(provider().complete(request, never));
    expect(failure.kind).toBe('provider_error');
    expect(failure.status).toBeUndefined();
  });

  /**
   * Behaves as the real `fetch` does with a signal: rejects at once if it is already
   * aborted, otherwise when it aborts. A stub that ignored the signal would let these
   * tests pass without cancellation ever reaching the network layer — so each one also
   * asserts that the signal `fetch` received really was aborted.
   */
  function abortableFetch(): { started: Promise<void>; sawAbort: () => boolean } {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let received: AbortSignal | undefined;

    stubFetch((_input, init) => {
      received = init?.signal ?? undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (received?.aborted) {
          abort();
          return;
        }
        received?.addEventListener('abort', abort, { once: true });
      });
    });

    return { started, sawAbort: () => received?.aborted === true };
  }

  it('cancels an in-flight call when the service aborts, and reports a timeout', async () => {
    const { started, sawAbort } = abortableFetch();
    const controller = new AbortController();

    const pending = failureFrom(provider().complete(request, controller.signal));
    // Abort while the request is genuinely on the wire, not before the SDK reaches fetch.
    await started;
    controller.abort();

    expect((await pending).kind).toBe('timeout');
    expect(sawAbort()).toBe(true);
  });

  it('forwards an already-aborted signal to fetch and reports a timeout', async () => {
    const { sawAbort } = abortableFetch();

    const failure = await failureFrom(provider().complete(request, AbortSignal.abort()));

    expect(failure.kind).toBe('timeout');
    // The SDK passed the cancellation to fetch rather than ignoring it.
    expect(sawAbort()).toBe(true);
  });

  it('maps a blocked prompt to refused, keeping only the block reason', async () => {
    ok({ promptFeedback: { blockReason: 'SAFETY' }, modelVersion: MODEL });

    const failure = await failureFrom(provider().complete(request, never));
    expect(failure.kind).toBe('refused');
    expect(failure.code).toBe('SAFETY');
  });

  for (const reason of ['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT']) {
    it(`maps finishReason ${reason} to refused, dropping the prose explanation`, async () => {
      ok(
        geminiBody({
          candidates: [
            { content: { parts: [] }, finishReason: reason, finishMessage: 'prose quoting cơm tấm' },
          ],
        }),
      );

      const failure = await failureFrom(provider().complete(request, never));
      expect(failure.kind).toBe('refused');
      expect(failure.code).toBe(reason);
      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('prose quoting');
    });
  }

  it('maps a non-JSON payload to a statusless provider_error', async () => {
    ok(geminiBody({ candidates: [{ content: { parts: [{ text: 'Sure! Here it is:' }] }, finishReason: 'STOP' }] }));

    const failure = await failureFrom(provider().complete(request, never));
    expect(failure.kind).toBe('provider_error');
    expect(failure.status).toBeUndefined();
  });

  it('maps an empty, truncated answer to a provider_error naming the finish reason', async () => {
    ok(geminiBody({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }));

    const failure = await failureFrom(provider().complete(request, never));
    expect(failure.kind).toBe('provider_error');
    expect(failure.code).toBe('MAX_TOKENS');
  });
});

describe('GeminiProvider — the SDK must not retry', () => {
  // The SDK retries up to five times when `retryOptions` is set. If that were ever
  // configured, AiService's two-call budget would quietly become ten calls — so these
  // count requests rather than trusting the configuration.
  for (const [status, label] of [
    [429, 'RESOURCE_EXHAUSTED'],
    [503, 'UNAVAILABLE'],
  ] as const) {
    it(`makes exactly one HTTP call on a ${status}`, async () => {
      const fetchMock = stubFetch(async () => googleError(status, label));
      await provider().complete(request, never).catch(() => undefined);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
});

describe('GeminiProvider — what a failure may not carry', () => {
  it('never exposes the API key, the error body, or the user text', async () => {
    stubFetch(async () => googleError(400, 'INVALID_ARGUMENT'));

    const failure = await failureFrom(provider().complete(request, never));

    const dump = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
    expect(dump).not.toContain(API_KEY);
    // `message` is what a careless logger prints first.
    expect(failure.message).not.toContain('upstream detail');
    expect(failure.message).not.toContain('cơm');
  });
});

describe('toGeminiJsonSchema', () => {
  it('drops unsupported keywords at every depth', () => {
    expect(
      toGeminiJsonSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          quantity: { anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: 50 }, { type: 'null' }] },
        },
        required: ['name', 'quantity'],
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        quantity: { anyOf: [{ type: 'number', maximum: 50 }, { type: 'null' }] },
      },
      required: ['name', 'quantity'],
      additionalProperties: false,
    });
  });

  it('keeps property names that happen to collide with keyword names', () => {
    // Under `properties` the keys are names, not keywords, and every one must survive.
    expect(
      toGeminiJsonSchema({
        type: 'object',
        properties: { minLength: { type: 'number' }, format: { type: 'string' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { minLength: { type: 'number' }, format: { type: 'string' } },
    });
  });

  it('does not mutate its input', () => {
    const schema = { type: 'string', maxLength: 5 };
    toGeminiJsonSchema(schema);
    expect(schema).toEqual({ type: 'string', maxLength: 5 });
  });
});

/**
 * The seam itself: the real `AiService` over the real adapter, proving the layers still
 * divide the way Task 2 arranged them.
 */
describe('AiService → GeminiProvider', () => {
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

  const service = (runs: AiRunRecorder) =>
    new AiService({ providers: [provider()], runs, estimateCost, sleep: async () => {} });

  const call = {
    userId: '00000000-0000-4000-8000-0000000000cc',
    purpose: 'meal_vision' as const,
    provider: 'google' as const,
    model: MODEL,
    schema,
    system: request.system,
    user: request.user,
    jsonSchema: request.jsonSchema,
    image: { mimeType: 'image/webp', data: IMAGE },
  };

  it('validates a Gemini response with the caller schema and meters it at Gemini prices', async () => {
    ok();
    const runs = recorder();

    const result = await service(runs).run(call);

    expect(result.value).toEqual({ answer: 'cơm tấm' });
    expect(runs.rows[0]).toMatchObject({
      provider: 'google',
      purpose: 'meal_vision',
      model: MODEL,
      status: 'ok',
      inputTokens: 1290,
      outputTokens: 40,
    });
    // 1290 × $0.30/MTok + 40 × $2.50/MTok = 0.000387 + 0.0001.
    expect(runs.rows[0]?.costUsd).toBe(0.000487);
  });

  it('retries a 503 exactly once — the service owns the budget, not the SDK', async () => {
    let calls = 0;
    const fetchMock = stubFetch(async () => {
      calls += 1;
      return calls === 1 ? googleError(503, 'UNAVAILABLE') : jsonResponse(geminiBody());
    });
    const runs = recorder();

    const result = await service(runs).run(call);

    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runs.rows.map((row) => row.status)).toEqual(['provider_error', 'ok']);
  });

  it('stops after two HTTP calls when Gemini keeps failing', async () => {
    const fetchMock = stubFetch(async () => googleError(503, 'UNAVAILABLE'));
    const runs = recorder();

    await expect(service(runs).run(call)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runs.rows).toHaveLength(2);
  });

  it('never lets the image, the prompt or the key reach the ledger', async () => {
    ok();
    const runs = recorder();
    await service(runs).run(call);

    const dump = JSON.stringify(runs.rows);
    expect(dump).not.toContain(IMAGE.toString('base64'));
    expect(dump).not.toContain('re-encoded-webp-bytes');
    expect(dump).not.toContain(request.system);
    expect(dump).not.toContain(API_KEY);
  });
});
