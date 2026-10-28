import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../database/client.js';
import { ConflictError, InternalError, ValidationError } from '../../lib/errors.js';
import {
  IdempotencyRepository,
  type IdempotencyScope,
  type StoredResponse,
} from './idempotency.repository.js';

/**
 * `Idempotency-Key` (API_DESIGN.md §1) for the writes that create user data.
 *
 * Optional: a request without the header behaves exactly as it always has. With it:
 *
 * - **Atomic.** The key row is claimed, the record written and the response stored in one
 *   transaction. Either all of it commits or none of it does, so there is never a record
 *   without its key, nor a key claiming a record that does not exist.
 * - **Concurrency-safe.** A duplicate arriving mid-write waits on the uncommitted key row
 *   (the primary key) and then replays what the first one stored.
 * - **Side effects once.** The day refresh runs after the commit and is then marked done.
 *   A retry of a completed write replays the stored response and runs nothing. A retry of
 *   a write whose refresh never finished — it threw, or the process died — finishes the
 *   refresh first. The refresh is a recompute from source data, so finishing it twice in a
 *   race is harmless.
 * - **Same key, different request:** `409 CONFLICT`. The record is never touched.
 * - **24 hours.** After that, the key is free and a request using it is a new write.
 */

/** Visible ASCII, which every header-safe random id is (UUID, ULID, base64url). */
const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw new ValidationError('Idempotency-Key must be 1–255 visible ASCII characters (headers)', [
      { path: 'idempotency-key', issue: 'invalid_string' },
    ]);
  }
  return raw;
}

/**
 * A fingerprint of the validated body. Key order is normalised so the same request is the
 * same hash however the client serialised it; dates are hashed as their ISO form.
 */
export function requestHash(body: unknown): string {
  const canonical = JSON.stringify(body ?? null, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export interface KeyedOutcome {
  statusCode: number;
  body: unknown;
  /** True when this answer is a stored one, not a new write. */
  replayed: boolean;
}

export class IdempotencyService {
  constructor(private readonly db: Db) {}

  async run(
    scope: IdempotencyScope,
    hash: string,
    write: (db: Db) => Promise<StoredResponse>,
    refresh: (localDate: string) => Promise<void>,
  ): Promise<KeyedOutcome> {
    const repository = new IdempotencyRepository(this.db);
    await repository.deleteExpired(scope.userId);

    const fresh = await this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const keys = new IdempotencyRepository(db);
      if (!(await keys.claim(scope, hash))) return null;
      const stored = await write(db);
      await keys.record(scope, stored);
      return stored;
    });

    if (fresh) {
      // If this throws, the record and its stored response are already committed; a retry
      // with the same key finishes the refresh and replays, rather than writing again.
      await refresh(fresh.localDate);
      await repository.markCompleted(scope);
      return { statusCode: fresh.statusCode, body: fresh.body, replayed: false };
    }

    const existing = await repository.find(scope);
    if (!existing || existing.statusCode === null) {
      // Claimed by a transaction that has since committed, so the row is complete — unless
      // it vanished in between (the user was deleted). Nothing safe to replay.
      throw new InternalError('Idempotency key could not be resolved');
    }
    if (existing.requestHash !== hash) {
      throw new ConflictError('This Idempotency-Key was already used for a different request');
    }
    if (!existing.completedAt) {
      if (existing.localDate) await refresh(existing.localDate);
      await repository.markCompleted(scope);
    }
    return { statusCode: existing.statusCode, body: existing.response, replayed: true };
  }
}

export interface KeyedWrite {
  /** The route this is, as the key's scope: "POST /api/events". */
  operation: string;
  /** The write. `db` is a transaction when a key was sent, and `undefined` otherwise. */
  write: (db: Db | undefined) => Promise<StoredResponse>;
  refresh: (localDate: string) => Promise<void>;
}

/**
 * Runs a route's write with or without a key, and sends the answer. Without a key it is
 * the write and then the refresh, exactly as before keys existed.
 */
export async function respondIdempotently(
  request: FastifyRequest,
  reply: FastifyReply,
  service: IdempotencyService,
  userId: string,
  spec: KeyedWrite,
): Promise<unknown> {
  const key = idempotencyKeyOf(request);

  if (key === undefined) {
    const written = await spec.write(undefined);
    await spec.refresh(written.localDate);
    return reply.status(written.statusCode).send(written.body);
  }

  const outcome = await service.run(
    { userId, operation: spec.operation, key },
    requestHash(request.body),
    (db) => spec.write(db),
    spec.refresh,
  );
  if (outcome.replayed) reply.header('Idempotent-Replayed', 'true');
  return reply.status(outcome.statusCode).send(outcome.body);
}
