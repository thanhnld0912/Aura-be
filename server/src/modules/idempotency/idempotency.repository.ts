import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { idempotencyKeys } from '../../database/schema/index.js';

export type IdempotencyRow = typeof idempotencyKeys.$inferSelect;

/** Who sent the key, to which operation. A key means nothing outside this scope. */
export interface IdempotencyScope {
  userId: string;
  operation: string;
  key: string;
}

export interface StoredResponse {
  statusCode: number;
  body: unknown;
  /** The local day the write landed on, which is the day a refresh recomputes. */
  localDate: string;
}

/** API_DESIGN.md §1: keys are stored for 24 hours. */
const EXPIRED = sql`${idempotencyKeys.createdAt} < now() - interval '24 hours'`;

const inScope = (scope: IdempotencyScope) =>
  and(
    eq(idempotencyKeys.userId, scope.userId),
    eq(idempotencyKeys.operation, scope.operation),
    eq(idempotencyKeys.key, scope.key),
  );

export class IdempotencyRepository {
  constructor(private readonly db: Db) {}

  /**
   * Claims the key for the transaction this repository is bound to. True when this
   * transaction now owns it: the key was new, or its row had expired and is taken over.
   *
   * The primary key does the concurrency work. A second request inserting the same key
   * while the first is uncommitted waits on that row; once the first commits it sees a
   * conflict and claims nothing, and if the first rolls back it claims the key itself.
   */
  async claim(scope: IdempotencyScope, requestHash: string): Promise<boolean> {
    const rows = await this.db
      .insert(idempotencyKeys)
      .values({ ...scope, requestHash })
      .onConflictDoUpdate({
        target: [idempotencyKeys.userId, idempotencyKeys.operation, idempotencyKeys.key],
        set: {
          requestHash,
          statusCode: null,
          response: null,
          localDate: null,
          createdAt: sql`now()`,
          completedAt: null,
        },
        setWhere: EXPIRED,
      })
      .returning({ key: idempotencyKeys.key });
    return rows.length > 0;
  }

  async record(scope: IdempotencyScope, stored: StoredResponse): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ statusCode: stored.statusCode, response: stored.body, localDate: stored.localDate })
      .where(inScope(scope));
  }

  async find(scope: IdempotencyScope): Promise<IdempotencyRow | undefined> {
    const rows = await this.db.select().from(idempotencyKeys).where(inScope(scope)).limit(1);
    return rows[0];
  }

  async markCompleted(scope: IdempotencyScope): Promise<void> {
    await this.db.update(idempotencyKeys).set({ completedAt: sql`now()` }).where(inScope(scope));
  }

  /** This user's expired keys. Run on each keyed write, so the table holds about a day per user. */
  async deleteExpired(userId: string): Promise<void> {
    await this.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.userId, userId), EXPIRED));
  }
}
