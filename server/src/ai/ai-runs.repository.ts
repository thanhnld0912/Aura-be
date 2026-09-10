import type { Db } from '../database/client.js';
import { aiRuns, type AiRequestMeta } from '../database/schema/ai.js';
import type { AiProviderName, AiPurpose, AiStatus } from './types.js';

/**
 * The only layer that writes `ai_runs` (ARCHITECTURE.md §5).
 *
 * Append-only by design: there is no update and no delete. An attempt that failed and
 * was retried successfully leaves both rows, because the failure rate of a prompt is
 * the number this table exists to produce, and a ledger that tidies away its failures
 * reports every prompt as perfect.
 */

export type AiRunRow = typeof aiRuns.$inferSelect;

export interface RecordAiRunInput {
  /** Always the authenticated caller's id. Never taken from a request body. */
  userId: string;
  purpose: AiPurpose;
  provider: AiProviderName;
  model: string;
  status: AiStatus;
  latencyMs: number;
  attempt: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  /** Null whenever usage was not reported — never an estimate (DATABASE_DESIGN §3.8). */
  costUsd?: number | null | undefined;
  /** Already sanitised by the service. This layer does not inspect it. */
  error?: string | null | undefined;
  requestMeta?: AiRequestMeta | undefined;
}

/**
 * What `AiService` needs from the ledger, and no more.
 *
 * An interface rather than the class, so a test can hand the service an in-memory
 * recorder without a database and without casting past a private field.
 */
export interface AiRunRecorder {
  record(input: RecordAiRunInput): Promise<AiRunRow>;
}

export class AiRunsRepository implements AiRunRecorder {
  constructor(private readonly db: Db) {}

  async record(input: RecordAiRunInput): Promise<AiRunRow> {
    const [row] = await this.db
      .insert(aiRuns)
      .values({
        userId: input.userId,
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        status: input.status,
        latencyMs: input.latencyMs,
        attempt: input.attempt,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cacheReadInputTokens: input.cacheReadInputTokens ?? null,
        // numeric(10,6) round-trips as a string in postgres-js, as elsewhere in the schema.
        costUsd: input.costUsd === null || input.costUsd === undefined ? null : input.costUsd.toFixed(6),
        error: input.error ?? null,
        requestMeta: input.requestMeta ?? null,
      })
      .returning();

    if (!row) throw new Error('ai_runs insert returned no row');
    return row;
  }
}
