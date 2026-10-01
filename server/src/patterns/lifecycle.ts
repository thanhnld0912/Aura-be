/**
 * The persisted pattern lifecycle (PATTERN_ENGINE.md §4), as pure decisions. The repository
 * applies them; nothing here reads a database or a clock — `now` is always passed in.
 *
 * ```
 * (none) ──detected──> active ──detected again──> active        (last_detected_at moves)
 *                        │
 *                        ├──not detected──> stale ──detected──> active
 *                        │                    └──30 days──> deleted (the row is removed)
 *                        └──dismissed──> dismissed ──detected, ≥ 60 days──> active
 *                                            └──detected, < 60 days──> unchanged
 * ```
 *
 * `status_changed_at` is the clock for both durations: while a row is dismissed it is the
 * moment of dismissal, while it is stale the moment it went stale. `first_detected_at` is
 * never moved by any transition.
 */

export type PersistedPatternStatus = 'active' | 'stale' | 'dismissed';

/** A stale pattern is deleted this long after it went stale. */
export const STALE_RETENTION_DAYS = 30;
/** A dismissed pattern is excluded from detection this long after dismissal. */
export const DISMISSAL_COOLDOWN_DAYS = 60;

const DAY_MS = 86_400_000;

export interface LifecycleState {
  status: PersistedPatternStatus;
  statusChangedAt: Date;
  /** The local date the stored evidence ends on. */
  windowEnd: string;
}

export type DetectionDecision =
  /** Active, confirmed again: refresh the evidence and `last_detected_at`; status unchanged. */
  | 'redetect'
  /** Stale, or dismissed past the cooldown: becomes active again. */
  | 'reactivate'
  /** Dismissed within the cooldown: the detection is ignored and the row left untouched. */
  | 'suppressed'
  /** The detection's window ends before the stored one: an older run must not overwrite a newer one. */
  | 'outdated';

/** True once `days` whole days have passed since `since`. */
function elapsed(since: Date, now: Date, days: number): boolean {
  return now.getTime() - since.getTime() >= days * DAY_MS;
}

/** What a detection of an existing pattern does to it. */
export function decideDetection(existing: LifecycleState, detectedWindowEnd: string, now: Date): DetectionDecision {
  if (detectedWindowEnd < existing.windowEnd) return 'outdated';
  switch (existing.status) {
    case 'active':
      return 'redetect';
    case 'stale':
      return 'reactivate';
    case 'dismissed':
      return elapsed(existing.statusChangedAt, now, DISMISSAL_COOLDOWN_DAYS) ? 'reactivate' : 'suppressed';
  }
}

/** The moment before which a stale pattern has passed its retention and may be deleted. */
export function staleRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_RETENTION_DAYS * DAY_MS);
}
