import Anthropic, {
  APIConnectionTimeoutError,
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import { AiProviderFailure, type AiCompletion, type AiRequest, type AiUsage } from '../types.js';
import type { AiProvider } from './ai-provider.js';

/**
 * Anthropic transport, and nothing else.
 *
 * This file is the only place in the codebase that may import `@anthropic-ai/sdk`. It
 * turns an `AiRequest` into a Messages API call and the reply into an `AiCompletion`, or
 * throws an `AiProviderFailure`. Everything a caller might actually care about —
 * whether the JSON is *correct*, whether to try again, what it cost, what to write down
 * — belongs to `AiService`, and none of it happens here.
 *
 * Two consequences are worth stating, because they are easy to erode later:
 *
 * - **No Zod.** The response is parsed as JSON and handed over as `unknown`. A provider
 *   that validated its own output would be a provider that could quietly repair it.
 * - **No retries.** The client is constructed with `maxRetries: 0`. The SDK retries
 *   twice by default, which would silently turn the service's two-call budget into six
 *   calls and six times the bill.
 *
 * The provider is also model-agnostic on purpose. `AiRequest.model` decides, so the
 * extraction path (Haiku) and the future reasoning path (Opus) are the same code with
 * different arguments — and, importantly, the reasoning path's `thinking`/`effort`
 * settings are *not* smuggled into extraction, where Haiku 4.5 rejects them outright.
 */

export interface ClaudeProviderConfig {
  /** From `env.ANTHROPIC_API_KEY`. Never read from `process.env` in this file. */
  apiKey: string;
  /** Overridden only by tests pointing at a local stub. */
  baseUrl?: string;
  /**
   * Injected transport, exactly as the nutrition providers do it. Tests drive the real
   * SDK over a fake `fetch`, so error mapping is verified against the SDK's own
   * exception hierarchy rather than against hand-built imitations of it.
   */
  fetchImpl?: typeof fetch;
}

export class ClaudeProvider implements AiProvider {
  readonly name = 'anthropic' as const;

  private readonly client: Anthropic;

  constructor(config: ClaudeProviderConfig) {
    // The SDK falls back to `process.env.ANTHROPIC_API_KEY` when handed nothing, which
    // would make this provider work on a developer's laptop and fail in an environment
    // where the key is absent from the parsed config — the exact drift `env.ts` exists
    // to prevent. `OpenFoodFactsProvider` refuses to construct for the same reason.
    if (!config.apiKey) {
      throw new Error('ClaudeProvider requires an API key from the parsed environment');
    }

    this.client = new Anthropic({
      apiKey: config.apiKey,
      // Mandatory. `AiService` owns the retry budget; see the class comment.
      maxRetries: 0,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
    });
  }

  async complete(request: AiRequest, signal: AbortSignal): Promise<AiCompletion> {
    let message: Message;

    try {
      message = await this.client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          // Structured output when the caller supplied a schema, plain text otherwise.
          // `AiRequest.jsonSchema` is already JSON Schema — the caller produced it with
          // `zod-to-json-schema` — so it passes straight through.
          ...(hasSchema(request.jsonSchema)
            ? { output_config: { format: { type: 'json_schema' as const, schema: request.jsonSchema } } }
            : {}),
        },
        {
          // The service's `AbortController` is the cancellation path; the timeout is a
          // belt-and-braces copy of the same budget for the case where the socket hangs
          // before the signal is wired up.
          signal,
          timeout: request.timeoutMs,
          maxRetries: 0,
        },
      );
    } catch (error) {
      throw toFailure(error);
    }

    if (message.stop_reason === 'refusal') {
      // The category is a fixed enum (`cyber`, `bio`, …), so it is safe to keep as a
      // grouping label. `stop_details.explanation` is free prose and is deliberately
      // dropped — it can quote the request, and the request is the user's text.
      throw new AiProviderFailure('refused', 'the model declined the request', {
        ...(message.stop_details?.category ? { code: message.stop_details.category } : {}),
      });
    }

    return {
      output: extractOutput(message, hasSchema(request.jsonSchema)),
      provider: this.name,
      model: message.model,
      ...(toUsage(message.usage) ? { usage: toUsage(message.usage) as AiUsage } : {}),
    };
  }
}

function hasSchema(jsonSchema: Record<string, unknown>): boolean {
  return Object.keys(jsonSchema).length > 0;
}

/**
 * The reply's payload, from however many blocks it arrived in.
 *
 * A response is a *list* of content blocks, and with thinking enabled the answer is not
 * block zero — so every `text` block is concatenated and the rest ignored, rather than
 * reaching for `content[0].text` and getting a reasoning trace on the day someone turns
 * thinking on.
 */
function extractOutput(message: Message, expectJson: boolean): unknown {
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!expectJson) return text;

  if (text.trim().length === 0) {
    // `max_tokens` truncation lands here when the model produced nothing usable.
    throw unexpectedShape(message, 'the response contained no text content');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw unexpectedShape(message, 'the response was not valid JSON');
  }
}

/**
 * A structurally wrong reply, as a failure the service can classify.
 *
 * No status, because no HTTP error occurred — the call succeeded and the *content* was
 * unusable. `AiService` treats a statusless provider error as retryable, which is right
 * for a one-off bad generation and merely wasteful in the deterministic case
 * (`max_tokens` too low will truncate again). One extra call is a better trade than
 * inventing an HTTP status the server never sent, which would put a fiction in the
 * ledger that a dashboard would later read as real.
 */
function unexpectedShape(message: Message, why: string): AiProviderFailure {
  return new AiProviderFailure('provider_error', why, {
    // `stop_reason` is a fixed enum, so it groups failures without carrying content.
    ...(message.stop_reason ? { code: message.stop_reason } : {}),
  });
}

function toUsage(usage: Message['usage'] | undefined): AiUsage | undefined {
  if (!usage) return undefined;

  // `input_tokens` and `output_tokens` are always present; the cache field is null on a
  // request that did not use caching, and a null stays absent rather than becoming 0.
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens !== null && usage.cache_read_input_tokens !== undefined
      ? { cacheReadInputTokens: usage.cache_read_input_tokens }
      : {}),
  };
}

/**
 * An SDK exception, as a provider-neutral failure.
 *
 * The mapping carries a kind, an HTTP status and a `Retry-After` hint, and nothing else.
 * In particular it never carries `error.message`: Anthropic's 400 bodies quote the
 * offending request back, and for AURA that request is somebody's meal description or
 * their note about how they slept. `AiService.sanitizeError` is the second line of that
 * defence; this is the first.
 *
 * The classification itself is not made here — `AiService.isRetryable` reads the status.
 * This function only reports what happened.
 */
function toFailure(error: unknown): AiProviderFailure {
  // Order matters: the timeout subclasses `APIConnectionError`, which subclasses
  // `APIError`, so the specific cases have to be tested first.
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return new AiProviderFailure('timeout', 'the provider call timed out', { cause: error });
  }

  if (error instanceof APIConnectionError) {
    // No status: the request never became an HTTP response. Retryable.
    return new AiProviderFailure('provider_error', 'could not reach the provider', {
      cause: error,
    });
  }

  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    return new AiProviderFailure('provider_error', 'the provider rejected the request', {
      ...(status !== undefined ? { status } : {}),
      // `error.type` is Anthropic's own enum — `rate_limit_error`, `invalid_request_error`.
      ...(error.type ? { code: error.type } : {}),
      ...(retryAfterMs(error) !== undefined ? { retryAfterMs: retryAfterMs(error) as number } : {}),
      cause: error,
    });
  }

  // Anything else is a bug in this file or in the SDK. Still a failed attempt, and still
  // nothing from it is persisted.
  return new AiProviderFailure('provider_error', 'the provider call failed', { cause: error });
}

/** `Retry-After`, in milliseconds, when the response carried a usable one. */
function retryAfterMs(error: APIError): number | undefined {
  const header = error.headers?.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return Math.round(seconds * 1_000);
}
