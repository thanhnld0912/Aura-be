import { relations } from 'drizzle-orm';
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { aiProviderEnum, aiPurposeEnum, aiStatusEnum } from './enums.js';
import { users } from './users.js';

/**
 * `ai_runs` — the cost and reliability ledger (DATABASE_DESIGN.md §3.8).
 *
 * One row per **provider attempt**, not per request. A call that fails its schema and
 * succeeds on the retry writes two rows, and neither overwrites the other: the point of
 * the table is to make `schema_error` rate measurable when a prompt changes, and a
 * ledger that only records the attempt that worked cannot do that.
 *
 * ## What is deliberately absent
 *
 * No prompt, no response, no image, no food name, no user text. `request_meta` carries
 * shape — how many characters went in, how many items came back, which schema paths
 * failed — and nothing that would make this table worth reading for its content.
 * `meals.raw_input` already holds what the user typed, under their own RLS policy;
 * copying it into an operational ledger would widen the blast radius of a leak without
 * adding anything a debugger needs.
 */

/** Privacy-conscious call metadata. Shape and size only — never content. */
export interface AiRequestMeta {
  /** Which prompt template produced the call, e.g. `meal-extract-v1`. */
  promptVersion?: string;
  /** Length of the input, not the input. */
  inputChars?: number;
  /** How many items the model returned, for prompt-quality trending. */
  itemCount?: number;
  imageBytes?: number;
  imageMime?: string;
  /** Zod paths that failed, e.g. `items.0.unit`. Paths only, never values. */
  schemaErrorPaths?: string[];
}

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: aiPurposeEnum('purpose').notNull(),
    provider: aiProviderEnum('provider').notNull(),
    /** Free text: see the note on `aiPurposeEnum` for why this one is not an enum. */
    model: text('model').notNull(),
    status: aiStatusEnum('status').notNull(),
    /**
     * Usage, when the provider reported it. All nullable, and that is load-bearing:
     * a timeout has no usage at all, and a null cost is the honest answer where a
     * zero would understate the bill and an estimate would invent one.
     */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** Non-zero here is the only proof prompt caching is actually working. */
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    /** Always measurable, even for a call that returned nothing. */
    latencyMs: integer('latency_ms').notNull(),
    /** 1 for the first try, 2 for the retry. Bounded by the service's policy. */
    attempt: integer('attempt').notNull().default(1),
    /** Sanitised: a short classification, never a provider payload or a stack. */
    error: text('error'),
    requestMeta: jsonb('request_meta').$type<AiRequestMeta>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ai_runs_user_time').on(table.userId, table.createdAt.desc()),
    index('idx_ai_runs_purpose').on(table.purpose, table.createdAt.desc()),
  ],
);

export const aiRunsRelations = relations(aiRuns, ({ one }) => ({
  user: one(users, { fields: [aiRuns.userId], references: [users.id] }),
}));
