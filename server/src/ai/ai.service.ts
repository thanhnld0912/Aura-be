import type { ZodTypeAny, z } from 'zod';
import type { AiRequestMeta } from '../database/schema/ai.js';
import { AiSchemaError, ProviderError, ProviderUnavailableError } from '../lib/errors.js';
import type { AiRunRecorder, AiRunRow } from './ai-runs.repository.js';
import type { AiProvider } from './providers/ai-provider.js';
import {
  isAiProviderFailure,
  type AiCompletion,
  type AiProviderFailure,
  type AiProviderName,
  type AiPurpose,
  type AiRequest,
  type AiStatus,
} from './types.js';

/**
 * Call a provider, insist the answer matches a schema, retry once, and write down what
 * it cost — for any provider and any schema.
 *
 * ## What this layer is for
 *
 * Model output is external input. It arrives as `unknown`, it is checked against a
 * schema the *caller* supplies, and only a value that passes reaches application code
 * (Rule 10). Nothing meal-specific lives here: the schema, the prompt and the purpose
 * are all arguments, so the meal extractor and, later, the agent are callers rather
 * than special cases.
 *
 * ## The retry budget, and why it is small
 *
 * At most **two** provider calls per request. One retry buys back the common transient
 * failures — a 429, a dropped socket, a model that got the shape wrong once — and a
 * third would mostly buy a slower error and a larger bill. Providers are required to
 * disable their SDK's own retries so this number means what it says.
 *
 * Every attempt writes an `ai_runs` row before the next one starts, so a request that
 * failed and then succeeded leaves the failure visible.
 */

export interface AiServiceDeps {
  providers: AiProvider[];
  runs: AiRunRecorder;
  /** Injected for tests, as `MealsService` does with its clock. */
  now?: () => number;
  /** Injected so the suite does not actually wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Turns usage into dollars. Absent until a real provider brings a price list, and
   * absent means `cost_usd` is null — never a guess (DATABASE_DESIGN.md §3.8).
   */
  estimateCost?: (input: { model: string; usage: AiUsageReport }) => number | null;
}

type AiUsageReport = NonNullable<AiCompletion['usage']>;

export interface AiRunRequest<S extends ZodTypeAny> {
  /** From the verified token. This service never reads a user id from a payload. */
  userId: string;
  purpose: AiPurpose;
  provider: AiProviderName;
  model: string;
  /** The contract the response must satisfy before anything downstream sees it. */
  schema: S;
  system: string;
  user: string;
  /** JSON Schema handed to the provider, when it can constrain its own output. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  /** Merged into `request_meta`. Shape and size only — the type has no room for content. */
  meta?: AiRequestMeta;
}

export interface AiRunResult<T> {
  value: T;
  /** The row for the attempt that succeeded — what `daily_plans` and friends point at. */
  aiRunId: string;
  attempts: number;
}

const MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_BACKOFF_MS = 1_000;

/** One attempt's verdict, in the ledger's own vocabulary. */
interface Attempt {
  status: Extract<
    AiStatus,
    'ok' | 'schema_error' | 'provider_error' | 'timeout' | 'refused' | 'blocked'
  >;
  completion?: AiCompletion | undefined;
  failure?: AiProviderFailure | undefined;
  schemaIssuePaths?: string[] | undefined;
}

/**
 * Whether a failed attempt is worth repeating.
 *
 * Policy lives here rather than in the providers, so there is one place to read it and
 * one place to change it. A 4xx that is not 429 says the request was wrong, and sending
 * the same wrong request again only spends money to be told so twice.
 */
function isRetryable(attempt: Attempt): boolean {
  if (attempt.status === 'ok') return false;
  // A safety block is a decision about the request, not a failure of the call. Repeating
  // it would produce the same decision and a second ledger row saying so.
  if (attempt.status === 'blocked') return false;
  if (attempt.status === 'schema_error') return true;
  if (attempt.status === 'timeout') return true;
  if (attempt.status === 'refused') return false;

  const status = attempt.failure?.status;
  if (status === undefined) return true; // no HTTP response at all — a connection failure
  if (status === 429) return true;
  return status >= 500;
}

/**
 * What is safe to persist about a failure.
 *
 * Never the provider's message: a vendor error can echo the request back, and the
 * request is the user's meal description. A kind, a status and a short vendor label are
 * enough to group failures in a dashboard, and none of them can carry a prompt. The
 * label is stripped to word characters and truncated so it cannot smuggle a payload.
 */
function sanitizeError(attempt: Attempt): string | null {
  if (attempt.status === 'ok') return null;
  // Nothing failed, and the *reason* it was blocked is a classifier's claim about a
  // person. The status column already records that a block happened; the category stays
  // in memory and is never written down.
  if (attempt.status === 'blocked') return null;

  if (attempt.status === 'schema_error') {
    const count = attempt.schemaIssuePaths?.length ?? 0;
    return `schema_error (${count} issue${count === 1 ? '' : 's'})`;
  }

  const parts: string[] = [attempt.status];
  if (attempt.failure?.status !== undefined) parts.push(`status ${attempt.failure.status}`);
  const code = attempt.failure?.code;
  if (code) parts.push(code.replace(/[^a-z0-9_ -]/gi, '').slice(0, 64));
  return parts.join(' ');
}

/** `Retry-After` when the provider offered one; a second plus jitter otherwise. */
function backoffFor(attempt: Attempt): number {
  if (attempt.status === 'schema_error') return 0;
  const advised = attempt.failure?.retryAfterMs;
  if (advised !== undefined) return advised;
  return DEFAULT_BACKOFF_MS + Math.floor(Math.random() * 250);
}

export class AiService {
  private readonly providers: Map<AiProviderName, AiProvider>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: AiServiceDeps) {
    this.providers = new Map(deps.providers.map((provider) => [provider.name, provider]));
    this.now = deps.now ?? (() => Date.now());
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async run<S extends ZodTypeAny>(input: AiRunRequest<S>): Promise<AiRunResult<z.infer<S>>> {
    const provider = this.providers.get(input.provider);
    if (!provider) {
      // Nothing was called, so there is nothing to meter — a missing provider is a
      // deployment fault, not a failed AI call, and recording it as one would pollute
      // the failure rate the ledger exists to measure.
      throw new ProviderUnavailableError(`No AI provider configured for ${input.provider}`);
    }

    const request: AiRequest = {
      model: input.model,
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      jsonSchema: input.jsonSchema ?? {},
    };

    let last: Attempt | undefined;

    for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
      const startedAt = this.now();
      const attempt = await this.attempt(provider, request, input.schema);
      const latencyMs = Math.max(0, this.now() - startedAt);

      const row = await this.record(input, provider, attempt, attemptNumber, latencyMs);

      if (attempt.status === 'ok' && attempt.completion) {
        return {
          value: input.schema.parse(attempt.completion.output) as z.infer<S>,
          aiRunId: row.id,
          attempts: attemptNumber,
        };
      }

      last = attempt;
      if (attemptNumber === MAX_ATTEMPTS || !isRetryable(attempt)) break;

      await this.sleep(backoffFor(attempt));
    }

    throw this.toAppError(last);
  }

  /**
   * Records a request the safety layer stopped, without calling a provider.
   *
   * A separate entry point rather than a branch inside `run()`, for two reasons. The
   * retry loop, the provider lookup and the metering in `run()` are the most heavily
   * tested code in the AI layer and none of it applies to a request that never leaves
   * the process. And the ledger has to stay the one place `ai_runs` is written — a
   * caller that wrote its own blocked row would be the second.
   *
   * What lands in the row: the purpose, the provider that *would* have been called, the
   * model that *would* have been used, `status = blocked`, `attempt = 1`, the real time
   * the gate took, no usage, and `cost_usd` null, because nothing was spent. What does
   * not land in it: the text, the prompt, or which category matched.
   */
  async recordBlocked<S extends ZodTypeAny>(input: AiRunRequest<S>): Promise<AiRunRow> {
    const startedAt = this.now();
    const provider = this.providers.get(input.provider);
    const latencyMs = Math.max(0, this.now() - startedAt);

    return this.record(
      input,
      // Named even when unconfigured: the row says which vendor the call was headed for,
      // which is what makes blocked runs comparable with the ones that went through.
      provider ?? { name: input.provider },
      { status: 'blocked' },
      1,
      latencyMs,
    );
  }

  /** One provider call plus its schema verdict. Never throws for a provider failure. */
  private async attempt<S extends ZodTypeAny>(
    provider: AiProvider,
    request: AiRequest,
    schema: S,
  ): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const completion = await provider.complete(request, controller.signal);
      const parsed = schema.safeParse(completion.output);

      if (!parsed.success) {
        return {
          status: 'schema_error',
          completion,
          schemaIssuePaths: parsed.error.issues.map((issue) => issue.path.join('.')),
        };
      }

      return { status: 'ok', completion };
    } catch (error) {
      if (isAiProviderFailure(error)) {
        return { status: error.kind, failure: error };
      }
      // A provider that throws anything else has a bug. It is still a failed attempt,
      // and nothing about the thrown value is persisted, so nothing leaks by treating
      // it as one rather than letting it escape unmetered.
      return { status: 'provider_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async record<S extends ZodTypeAny>(
    input: AiRunRequest<S>,
    // Only the name is used, so a blocked run can name its intended vendor without
    // requiring one to be configured.
    provider: Pick<AiProvider, 'name'>,
    attempt: Attempt,
    attemptNumber: number,
    latencyMs: number,
  ): Promise<AiRunRow> {
    const usage = attempt.completion?.usage;
    const cost =
      usage && this.deps.estimateCost
        ? this.deps.estimateCost({ model: input.model, usage })
        : null;

    const meta: AiRequestMeta = {
      ...input.meta,
      // Length, never content. Overridable so an image caller can report bytes instead.
      inputChars: input.meta?.inputChars ?? input.user.length,
      ...(attempt.schemaIssuePaths ? { schemaErrorPaths: attempt.schemaIssuePaths } : {}),
      // A flag, not a reason: enough to count blocked runs, not enough to reconstruct
      // what anyone typed or what a classifier concluded about them.
      ...(attempt.status === 'blocked' ? { safety: 'blocked' as const } : {}),
    };

    return this.deps.runs.record({
      userId: input.userId,
      purpose: input.purpose,
      provider: provider.name,
      model: attempt.completion?.model ?? input.model,
      status: attempt.status,
      latencyMs,
      attempt: attemptNumber,
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: usage.cacheReadInputTokens }
        : {}),
      costUsd: cost,
      error: sanitizeError(attempt),
      requestMeta: meta,
    });
  }

  /**
   * The last attempt, as an HTTP-shaped error from the project's existing set
   * (`lib/errors.ts`). No new codes: `AI_SCHEMA_ERROR`, `PROVIDER_UNAVAILABLE` and
   * `PROVIDER_ERROR` already mean these three things.
   *
   * The split between the last two is about what the caller should do. A provider that
   * timed out or returned a 503 may work in a minute, so it is `PROVIDER_UNAVAILABLE`
   * (503). A refusal, or a request the provider rejected as malformed, will fail
   * identically forever, so it is `PROVIDER_ERROR` (502) and the caller is not invited
   * to try again.
   */
  private toAppError(attempt: Attempt | undefined): Error {
    if (attempt?.status === 'schema_error') {
      return new AiSchemaError('The AI response did not match the expected shape');
    }
    if (attempt && isRetryable(attempt)) {
      return new ProviderUnavailableError('The AI provider is temporarily unavailable');
    }
    return new ProviderError('ai', 'The AI provider could not complete this request');
  }
}
