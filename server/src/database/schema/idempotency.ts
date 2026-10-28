import { date, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * `Idempotency-Key` records (API_DESIGN.md §1): what a keyed write answered, so a retry of
 * the same request gets the same answer instead of a second row.
 *
 * Scoped to the user and the operation — two users, or the same key sent to two endpoints,
 * never collide. The row is inserted in the **same transaction** as the write it guards, so
 * it is never visible without its record, and a concurrent duplicate waits on it rather
 * than racing it.
 *
 * `completed_at` is set once the post-write refresh (plan matching, the day's summary) has
 * run. A committed row without it means the write landed but the refresh did not; a retry
 * finishes the refresh and then replays the stored answer.
 *
 * Kept for 24 hours: an older row is taken over by the next request that uses its key.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** "POST /api/events" — the route the key was sent to. */
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    /** SHA-256 of the validated request body, so a different payload under the same key is caught. */
    requestHash: text('request_hash').notNull(),
    /** Null only inside the transaction that is writing the row. */
    statusCode: integer('status_code'),
    response: jsonb('response'),
    /** The local day the write landed on — the day a retry refreshes. */
    localDate: date('local_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.operation, table.key] })],
);
