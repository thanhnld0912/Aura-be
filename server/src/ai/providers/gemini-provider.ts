import { ApiError, GoogleGenAI, type GenerateContentResponse, type Part } from '@google/genai';
import { AiProviderFailure, type AiCompletion, type AiRequest, type AiUsage } from '../types.js';
import type { AiProvider } from './ai-provider.js';

/**
 * Google Gemini transport, and nothing else.
 *
 * The only file in the codebase that may import `@google/genai`. Its job is the same as
 * `ClaudeProvider`'s: `AiRequest` in, `AiCompletion` out, or an `AiProviderFailure`. The
 * decisions that matter — is the output correct, is it worth retrying, what did it cost,
 * what gets written down — belong to `AiService`, and none of them happen here.
 *
 * ## Three things verified in the installed SDK, not assumed
 *
 * - **No SDK retries.** `ApiClient.apiCall` retries only when `httpOptions.retryOptions`
 *   is set (5 attempts by default if it is). It is never set here, so each call is one
 *   `fetch` — and the tests count the fetches rather than trusting this sentence.
 * - **Global `fetch`.** The SDK calls `fetch` directly, which is what lets the tests drive
 *   the real SDK over a stub, exercising its request building and its error types.
 * - **No ambient key.** The key comes from the parsed environment and nowhere else; an
 *   empty one refuses to construct, and `vertexai: false` pins the Gemini API so an
 *   unrelated environment variable cannot quietly re-route calls to Vertex.
 *
 * ## Model-agnostic, as the Claude adapter is
 *
 * `AiRequest.model` decides. No thinking configuration is sent: whether a model thinks,
 * and how that is controlled, differs between Gemini generations, and a setting chosen
 * for one would be a 400 on another. Thought tokens are billed as output, so they are
 * reported as output rather than dropped.
 */

export interface GeminiProviderConfig {
  /** From `env.GEMINI_API_KEY`. Never read from `process.env` in this file. */
  apiKey: string;
  /** Overridden only by tests pointing at a stub. */
  baseUrl?: string;
}

/**
 * Finish reasons that mean the provider declined, rather than that the output broke.
 * Each is a fixed enum value, so it is safe to keep as a grouping label.
 */
const REFUSAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

/**
 * The JSON Schema keywords `responseJsonSchema` accepts, as the SDK documents them.
 * Anything else — `minLength`, `maxLength`, `exclusiveMinimum`, `$schema` — is removed
 * before sending. That loses nothing: `AiService` validates the response against the full
 * Zod schema regardless, so the provider-side schema only has to steer, not guarantee.
 */
const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

export class GeminiProvider implements AiProvider {
  readonly name = 'google' as const;

  private readonly client: GoogleGenAI;

  constructor(config: GeminiProviderConfig) {
    if (!config.apiKey) {
      throw new Error('GeminiProvider requires an API key from the parsed environment');
    }

    this.client = new GoogleGenAI({
      apiKey: config.apiKey,
      vertexai: false,
      // `retryOptions` deliberately absent — see the class comment.
      httpOptions: config.baseUrl ? { baseUrl: config.baseUrl } : {},
    });
  }

  async complete(request: AiRequest, signal: AbortSignal): Promise<AiCompletion> {
    const expectJson = Object.keys(request.jsonSchema).length > 0;

    // Text first, then the image: Google's guidance for one image with a prompt.
    const parts: Part[] = [{ text: request.user }];
    if (request.image) {
      parts.push({
        inlineData: {
          mimeType: request.image.mimeType,
          data: request.image.data.toString('base64'),
        },
      });
    }

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: request.model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: request.system,
          maxOutputTokens: request.maxTokens,
          // The service's controller is the timeout. No second timer lives here.
          abortSignal: signal,
          ...(expectJson
            ? {
                responseMimeType: 'application/json',
                responseJsonSchema: toGeminiJsonSchema(request.jsonSchema),
              }
            : {}),
        },
      });
    } catch (error) {
      throw toFailure(error, signal);
    }

    // The prompt itself was refused, so no candidate exists at all.
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new AiProviderFailure('refused', 'the provider blocked the request', {
        code: blockReason,
      });
    }

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && REFUSAL_FINISH_REASONS.has(finishReason)) {
      // `finishMessage` is free prose and is deliberately not kept.
      throw new AiProviderFailure('refused', 'the provider declined to answer', {
        code: finishReason,
      });
    }

    const usage = toUsage(response.usageMetadata);

    return {
      output: extractOutput(candidate?.content?.parts ?? [], expectJson, finishReason),
      provider: this.name,
      model: response.modelVersion ?? request.model,
      ...(usage ? { usage } : {}),
    };
  }
}

/**
 * A JSON Schema narrowed to the keywords Gemini accepts.
 *
 * The keys of `properties` and `$defs` are property names, not keywords, so every one of
 * them survives and only its value is narrowed. Exported for its tests.
 */
export function toGeminiJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiJsonSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const narrowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;

    if ((key === 'properties' || key === '$defs') && value && typeof value === 'object') {
      narrowed[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, toGeminiJsonSchema(child)]),
      );
    } else if (key === 'enum' || key === 'required' || key === 'type' || key === 'propertyOrdering') {
      narrowed[key] = value;
    } else {
      narrowed[key] = toGeminiJsonSchema(value);
    }
  }
  return narrowed;
}

/**
 * The answer, from however many parts it arrived in.
 *
 * Thought parts are excluded — they are the model's reasoning, not its answer — and every
 * remaining text part is joined, rather than trusting the first one. The SDK's own `text`
 * getter is not used: it logs a console warning when non-text parts are present, and
 * nothing in this layer should write to the console.
 */
function extractOutput(
  parts: readonly Part[],
  expectJson: boolean,
  finishReason: string | undefined,
): unknown {
  const text = parts
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('');

  if (!expectJson) return text;

  if (text.trim().length === 0) {
    throw unexpectedShape('the response contained no text content', finishReason);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unexpectedShape('the response was not valid JSON', finishReason);
  }
}

/**
 * A structurally unusable reply. No status, because no HTTP error occurred; `AiService`
 * reads that as retryable, the same trade the Claude adapter makes.
 */
function unexpectedShape(why: string, finishReason: string | undefined): AiProviderFailure {
  return new AiProviderFailure('provider_error', why, {
    ...(finishReason ? { code: finishReason } : {}),
  });
}

/**
 * Gemini's usage, in AURA's vocabulary — which follows Anthropic's accounting.
 *
 * - **Input.** `promptTokenCount` *includes* cached tokens; AURA's `inputTokens` means
 *   uncached input, priced separately from cache reads. So cached tokens are subtracted,
 *   or they would be billed twice. Images are counted here too, at the text rate.
 * - **Output.** `candidatesTokenCount` plus `thoughtsTokenCount`: Google bills thinking as
 *   output, and a ledger that dropped it would under-report the cost of every call.
 * - **Absent stays absent.** A count Gemini did not send is not written as 0.
 */
function toUsage(metadata: GenerateContentResponse['usageMetadata']): AiUsage | undefined {
  if (!metadata) return undefined;

  const usage: AiUsage = {};
  const cached = metadata.cachedContentTokenCount;

  if (metadata.promptTokenCount !== undefined) {
    usage.inputTokens = Math.max(0, metadata.promptTokenCount - (cached ?? 0));
  }
  if (metadata.candidatesTokenCount !== undefined || metadata.thoughtsTokenCount !== undefined) {
    usage.outputTokens = (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0);
  }
  if (cached !== undefined) usage.cacheReadInputTokens = cached;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * An SDK or transport exception, as a provider-neutral failure.
 *
 * Carries a kind, an HTTP status and Google's own status label, and never the message:
 * Google's error bodies can quote the request back, and the request is a person's meal.
 * Classification is not decided here — `AiService.isRetryable` reads the status.
 */
function toFailure(error: unknown, signal: AbortSignal): AiProviderFailure {
  // Once the service's controller has fired, whatever fetch threw is the budget running
  // out — an AbortError or a TimeoutError, depending on how the runtime reports it.
  if (signal.aborted || isAbortLike(error)) {
    return new AiProviderFailure('timeout', 'the provider call timed out', { cause: error });
  }

  if (error instanceof ApiError) {
    const status = Number.isInteger(error.status) && error.status > 0 ? error.status : undefined;
    const label = statusLabel(error.message);
    return new AiProviderFailure('provider_error', 'the provider rejected the request', {
      ...(status !== undefined ? { status } : {}),
      ...(label ? { code: label } : {}),
      cause: error,
    });
  }

  // A socket that never became an HTTP response. No status, so retryable.
  return new AiProviderFailure('provider_error', 'could not reach the provider', { cause: error });
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Google's error enum — `RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT` — when the body has one.
 *
 * Matched strictly: an upper-case identifier in a `"status"` field, and nothing around
 * it. The surrounding message is exactly the text that must not be kept.
 */
function statusLabel(message: string): string | undefined {
  return /"status"\s*:\s*"([A-Z][A-Z_]{2,39})"/.exec(message)?.[1];
}
