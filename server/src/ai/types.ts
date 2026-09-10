import type { aiProviderEnum, aiPurposeEnum, aiStatusEnum } from '../database/schema/enums.js';

/**
 * The vocabulary the AI layer speaks, with no vendor in it.
 *
 * Everything here is derived from the database enums rather than re-declared, so a
 * status the service can produce is by construction a status the ledger can store.
 */

export type AiProviderName = (typeof aiProviderEnum.enumValues)[number];
export type AiPurpose = (typeof aiPurposeEnum.enumValues)[number];
export type AiStatus = (typeof aiStatusEnum.enumValues)[number];

/** What a provider reported about the call. Every field optional — many do not report. */
export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * What the caller asks a provider for.
 *
 * `jsonSchema` is a JSON Schema object, not a Zod schema. The provider needs something
 * it can hand to a vendor API; the Zod schema stays with the service, which is the only
 * layer allowed to decide whether a response is acceptable. Keeping Zod out of here is
 * also what stops a provider from being tempted to validate — and then to "fix" — an
 * output it should only be transporting.
 */
export interface AiRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  jsonSchema: Record<string, unknown>;
  /** Wall-clock budget for one attempt. Providers enforce it; the service times it. */
  timeoutMs: number;
}

/** What a provider returns. `output` is unvalidated — that is the service's job. */
export interface AiCompletion {
  output: unknown;
  provider: AiProviderName;
  model: string;
  usage?: AiUsage;
}

/**
 * Why an attempt did not produce an output.
 *
 * Mirrors `ai_status` minus the two the service decides for itself: `ok`, and
 * `schema_error`, which is a verdict on a response the provider delivered successfully.
 */
export type AiFailureKind = 'provider_error' | 'timeout' | 'refused';

/**
 * A provider failure, normalised.
 *
 * Providers translate their own SDK exceptions into this and nothing else, so the
 * service never sees an `Anthropic.RateLimitError` or a Google error shape. Note what
 * it carries and what it does not: a kind, an HTTP status, and a retry hint — enough
 * for the service to apply policy — but no response body and no request echo, because
 * this object's message is the one thing that could smuggle a prompt into a log.
 *
 * Retryability is deliberately **not** a field. That is policy, and policy lives in
 * `AiService` so there is exactly one place it can be read or changed.
 */
export class AiProviderFailure extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /** A short vendor-supplied label, e.g. a refusal category. Never free-form content. */
  readonly code: string | undefined;

  constructor(
    readonly kind: AiFailureKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiProviderFailure';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
  }
}

export function isAiProviderFailure(value: unknown): value is AiProviderFailure {
  return value instanceof AiProviderFailure;
}
