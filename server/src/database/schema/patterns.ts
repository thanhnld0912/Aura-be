import { relations, sql } from 'drizzle-orm';
import {
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { patternDirectionEnum, patternKindEnum, patternStatusEnum } from './enums.js';
import { users } from './users.js';

/**
 * The evidence a detector produced, snapshotted with the pattern (PATTERN_ENGINE.md §6):
 * the exact points behind the statistic, oldest first — what the chart draws. Written as
 * the detector returned them; nothing here recomputes or reshapes a value.
 */
export interface PatternEvidenceSnapshot {
  points: Array<{ localDate: string; subject: number; object: number }>;
}

/**
 * `patterns` — the **current** set of patterns the engine stands behind, one row per user
 * per logical pattern (DATABASE_DESIGN.md §3.7). Written by the Pattern Engine through
 * `PatternsRepository`, never by an LLM and never from request input.
 *
 * ## Identity
 *
 * `(user_id, key)`. The key is the detector's own (`correlationKey`, `timingKey`): kind,
 * the metric keys in canonical order, any condition. The window is evidence, not identity
 * — re-detecting a pattern over a later window updates its row, it does not add one.
 *
 * ## Not an audit history
 *
 * A row holds the latest evidence for a claim the data currently supports. Re-detection
 * overwrites it; `detector_version` and the window say which definition and which days
 * produced it. A pattern stale for 30 days is deleted (PATTERN_ENGINE.md §4).
 *
 * ## Deliberately absent
 *
 * `score`, rank and actionability are computed when serving (ranking depends on the
 * current time). `caveat` and the metric labels are deterministic presentation text by
 * kind and locale. `support` was never defined (D6). `narrative` arrives with narration.
 *
 * ## Numbers
 *
 * `double precision`, not `numeric`: a JS number round-trips exactly, so the stored
 * strength, p-value and coverage are the detector's values, not a rounding of them.
 */
export const patterns = pgTable(
  'patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),

    kind: patternKindEnum('kind').notNull(),
    subjectMetric: text('subject_metric').notNull(),
    /** Null for kinds about a single metric (trend, and frequency/streak as applicable). */
    objectMetric: text('object_metric'),
    /** The sign lives here, never in `strength` (D6). */
    direction: patternDirectionEnum('direction').notNull(),

    /** Magnitude, 0..1 — |r| for a correlation, |rate difference| for timing. */
    strength: doublePrecision('strength').notNull(),
    /** Null only for frequency/streak, which make no inference (D7). */
    pValue: doublePrecision('p_value'),
    sampleSize: integer('sample_size').notNull(),
    /** Days with every metric present / days in the window (PATTERN_ENGINE.md §2.2). */
    coverage: doublePrecision('coverage').notNull(),

    windowStart: date('window_start').notNull(),
    windowEnd: date('window_end').notNull(),
    windowDays: integer('window_days').notNull(),

    evidence: jsonb('evidence').$type<PatternEvidenceSnapshot>().notNull(),
    /** Which definition produced the row, e.g. `correlation@1` (`DETECTOR_REGISTRY`). */
    detectorVersion: text('detector_version').notNull(),

    status: patternStatusEnum('status').notNull().default('active'),
    /** Set once. Re-detection, staleness and reactivation never move it. */
    firstDetectedAt: timestamp('first_detected_at', { withTimezone: true }).notNull(),
    /** The last time a detector confirmed the pattern. */
    lastDetectedAt: timestamp('last_detected_at', { withTimezone: true }).notNull(),
    /**
     * When `status` last changed. It is what the lifecycle's clocks read: 30 days stale
     * before deletion, 60 days dismissed before a detection may reactivate it.
     */
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_patterns_user_key').on(table.userId, table.key),
    // The retention sweep reads stale rows across every user by age; nothing else does.
    index('idx_patterns_stale').on(table.statusChangedAt).where(sql`${table.status} = 'stale'`),
    check('chk_pattern_strength', sql`${table.strength} >= 0 and ${table.strength} <= 1`),
    check('chk_pattern_p_value', sql`${table.pValue} is null or (${table.pValue} >= 0 and ${table.pValue} <= 1)`),
    check('chk_pattern_coverage', sql`${table.coverage} >= 0 and ${table.coverage} <= 1`),
    check('chk_pattern_sample', sql`${table.sampleSize} >= 1`),
    check(
      'chk_pattern_window',
      sql`${table.windowDays} >= 1 and ${table.windowEnd} - ${table.windowStart} + 1 = ${table.windowDays}`,
    ),
    check(
      'chk_pattern_inference',
      sql`(${table.pValue} is null) = (${table.kind} in ('frequency', 'streak'))`,
    ),
    check(
      'chk_pattern_object',
      sql`${table.kind} not in ('correlation', 'timing') or ${table.objectMetric} is not null`,
    ),
    check('chk_pattern_key_kind', sql`starts_with(${table.key}, ${table.kind}::text || ':')`),
    check(
      'chk_pattern_detected_order',
      sql`${table.firstDetectedAt} <= ${table.lastDetectedAt}`,
    ),
  ],
);

export const patternsRelations = relations(patterns, ({ one }) => ({
  user: one(users, { fields: [patterns.userId], references: [users.id] }),
}));

/**
 * `pattern_watermarks` — the latest closed day the engine has evaluated for a user
 * (PATTERN_ENGINE_DECISIONS.md D17). One row per user, overwritten, never a history.
 *
 * It exists because `patterns` cannot hold this fact: a pattern row records its own last
 * detection window, but a run that **did not** find a pattern — the run that made it stale,
 * or a run for a user with no row for that key at all — leaves no date anywhere. Without it,
 * re-running an older day re-detects from older evidence and overrides what a newer run
 * decided. With it, a run for a day before the watermark is historical and writes no
 * lifecycle change; a run on or after it is authoritative and advances it.
 */
export const patternWatermarks = pgTable('pattern_watermarks', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The latest local day an authoritative detection run completed for this user. */
  evaluatedThrough: date('evaluated_through').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
