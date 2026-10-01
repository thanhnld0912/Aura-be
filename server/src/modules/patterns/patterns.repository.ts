import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../../database/client.js';
import { patternWatermarks, patterns } from '../../database/schema/patterns.js';
import { decideDetection, staleRetentionCutoff } from '../../patterns/lifecycle.js';
import type { DetectedPattern } from '../../patterns/persistence.js';

/**
 * The only writer of `patterns` (DATABASE_DESIGN.md §3.7).
 *
 * It persists what a detector produced — `toDetectedPattern` has already checked the
 * contract — and applies the lifecycle decisions of `patterns/lifecycle.ts`. It computes
 * no statistic and no evidence, and it has no generic update: each method is one
 * lifecycle transition.
 *
 * Every method that touches a user's patterns takes that user's id. The API passes the id
 * from the verified token; the engine passes the user it is processing. Neither comes from
 * request input. The backend's connection owns the table and is not filtered by RLS
 * (0011), so this scoping is the lock that matters here.
 *
 * `now` is a parameter so that the lifecycle's clocks (60-day cooldown, 30-day retention)
 * are testable; callers pass the current time.
 */

export type PatternRow = typeof patterns.$inferSelect;

export type DetectionOutcome =
  /** No row for this user and key: one was created, active. */
  | 'created'
  /** Active and confirmed again: evidence and `last_detected_at` refreshed. */
  | 'redetected'
  /** Stale, or dismissed past the cooldown: active again, with the new evidence. */
  | 'reactivated'
  /** Dismissed within the cooldown: left untouched. */
  | 'suppressed'
  /** Older than the stored evidence: left untouched. */
  | 'outdated';

export interface DetectionResult {
  outcome: DetectionOutcome;
  pattern: PatternRow;
}

/** The measured fields a detection writes. Identity and lifecycle fields are not among them. */
function measuredFields(detected: DetectedPattern) {
  return {
    kind: detected.kind,
    subjectMetric: detected.subjectMetric,
    objectMetric: detected.objectMetric,
    direction: detected.direction,
    strength: detected.strength,
    pValue: detected.pValue,
    sampleSize: detected.sampleSize,
    coverage: detected.coverage,
    windowStart: detected.windowStart,
    windowEnd: detected.windowEnd,
    windowDays: detected.windowDays,
    evidence: detected.evidence,
    detectorVersion: detected.detectorVersion,
  };
}

export class PatternsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Runs `work` in one transaction that holds this user's pattern lock, handing it a
   * repository bound to that transaction. A detection run persists its detections and
   * retires what it no longer finds as one unit: it commits whole or not at all, and two runs
   * for the same user cannot interleave (the second waits). Other users are not blocked.
   *
   * The methods' own transactions become savepoints inside it.
   */
  async withUserLock<T>(userId: string, work: (repository: PatternsRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`patterns:${userId}`}, 0))`);
      return work(new PatternsRepository(tx as unknown as Db));
    });
  }

  /** The latest day an authoritative detection run completed for this user, or null (D17). */
  async evaluatedThrough(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ evaluatedThrough: patternWatermarks.evaluatedThrough })
      .from(patternWatermarks)
      .where(eq(patternWatermarks.userId, userId));
    return row?.evaluatedThrough ?? null;
  }

  /**
   * Records that an authoritative run for `localDate` completed. Never moves the watermark
   * back: the later of the stored and the given day is kept.
   */
  async advanceEvaluatedThrough(userId: string, localDate: string, now: Date): Promise<void> {
    await this.db
      .insert(patternWatermarks)
      .values({ userId, evaluatedThrough: localDate, updatedAt: now })
      .onConflictDoUpdate({
        target: patternWatermarks.userId,
        set: {
          evaluatedThrough: sql`greatest(${patternWatermarks.evaluatedThrough}, excluded.evaluated_through)`,
          updatedAt: now,
        },
      });
  }

  async findByUserAndKey(userId: string, key: string): Promise<PatternRow | undefined> {
    return this.db.query.patterns.findFirst({
      where: and(eq(patterns.userId, userId), eq(patterns.key, key)),
    });
  }

  /**
   * This user's current patterns — `active` only, which is what serving means by current.
   * Stale and dismissed rows are lifecycle state, not claims to show. Order is not meaningful
   * here; ranking orders them (`patterns/ranking.ts`).
   */
  async listActive(userId: string): Promise<PatternRow[]> {
    return this.db
      .select()
      .from(patterns)
      .where(and(eq(patterns.userId, userId), eq(patterns.status, 'active')))
      .orderBy(patterns.key);
  }

  /**
   * A detector found this pattern for this user. Creates the row, or applies the lifecycle
   * to the existing one — never a second row for the same `(user_id, key)`.
   *
   * The existing row is locked for the decision, so a dismissal arriving at the same moment
   * either lands first (and is respected) or waits. Two first detections racing each other
   * meet at the unique index: the loser inserts nothing and takes the update path instead.
   */
  async recordDetection(userId: string, detected: DetectedPattern, now: Date): Promise<DetectionResult> {
    return this.db.transaction(async (tx) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const [existing] = await tx
          .select()
          .from(patterns)
          .where(and(eq(patterns.userId, userId), eq(patterns.key, detected.key)))
          .for('update');

        if (!existing) {
          const [created] = await tx
            .insert(patterns)
            .values({
              userId,
              key: detected.key,
              ...measuredFields(detected),
              status: 'active',
              firstDetectedAt: now,
              lastDetectedAt: now,
              statusChangedAt: now,
            })
            .onConflictDoNothing({ target: [patterns.userId, patterns.key] })
            .returning();
          if (created) return { outcome: 'created', pattern: created };
          continue; // inserted concurrently — lock that row and decide on it
        }

        const decision = decideDetection(existing, detected.windowEnd, now);
        if (decision === 'suppressed' || decision === 'outdated') return { outcome: decision, pattern: existing };

        const [updated] = await tx
          .update(patterns)
          .set({
            ...measuredFields(detected),
            status: 'active',
            lastDetectedAt: now,
            // Only a change of status moves this clock; first_detected_at never moves.
            ...(decision === 'reactivate' ? { statusChangedAt: now } : {}),
          })
          .where(eq(patterns.id, existing.id))
          .returning();
        if (!updated) throw new Error('pattern update returned no row');
        return { outcome: decision === 'reactivate' ? 'reactivated' : 'redetected', pattern: updated };
      }
      throw new Error(`pattern ${detected.key} could be neither inserted nor locked`);
    });
  }

  /**
   * A full detection run for this user did not find the pattern. Active → stale; any other
   * status is left as it is (a dismissal is the user's, and staleness does not override it).
   * Returns the row when it changed.
   */
  async markStale(userId: string, key: string, now: Date): Promise<PatternRow | undefined> {
    const [row] = await this.db
      .update(patterns)
      .set({ status: 'stale', statusChangedAt: now })
      .where(and(eq(patterns.userId, userId), eq(patterns.key, key), eq(patterns.status, 'active')))
      .returning();
    return row;
  }

  /**
   * The user says "that's not a real thing about me". Active or stale → dismissed, which
   * starts the cooldown. Dismissing an already dismissed pattern changes nothing (the
   * cooldown is not restarted). `undefined` when this user has no such pattern — the same
   * answer whether the id does not exist or belongs to someone else.
   */
  async dismiss(userId: string, id: string, now: Date): Promise<PatternRow | undefined> {
    const [row] = await this.db
      .update(patterns)
      .set({ status: 'dismissed', statusChangedAt: now })
      .where(
        and(eq(patterns.userId, userId), eq(patterns.id, id), inArray(patterns.status, ['active', 'stale'])),
      )
      .returning();
    if (row) return row;
    return this.db.query.patterns.findFirst({
      where: and(eq(patterns.userId, userId), eq(patterns.id, id), eq(patterns.status, 'dismissed')),
    });
  }

  /**
   * Retention: deletes every pattern that has been stale for at least 30 days, for every
   * user — the sweep a scheduled job runs. A hard delete, because there is no deleted state:
   * the table holds claims the data still supports, and these no longer qualify. Returns
   * how many were removed.
   */
  async deleteExpiredStale(now: Date): Promise<number> {
    const removed = await this.db
      .delete(patterns)
      .where(and(eq(patterns.status, 'stale'), lte(patterns.statusChangedAt, staleRetentionCutoff(now))))
      .returning({ id: patterns.id });
    return removed.length;
  }
}
