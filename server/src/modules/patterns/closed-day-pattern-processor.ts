import type { ClosedDayService } from '../summaries/closed-day.service.js';
import type { DetectionRunResult, PatternDetectionService } from './pattern-detection.service.js';

/**
 * One closed day for one user, in the authoritative order (D15):
 *
 * ```
 * finalise the day (reconcile plan vs actual, recompute the summary)  →  committed
 *        ↓
 * detect over the windows ending on it, persist, reconcile the lifecycle
 * ```
 *
 * The two are sequential and never concurrent: detection starts only after finalisation
 * has returned, and finalisation's writes are committed by then, so detection reads the
 * finalised summary. They are deliberately not one transaction — finalisation is several
 * independent upserts that are correct on their own and idempotent on a retry, and holding
 * the user's pattern lock across them would buy nothing.
 *
 * If finalisation fails, detection does not run: a day that could not be finalised is not
 * read as if it had been. The nightly job and the backfill both go through here.
 */
export class ClosedDayPatternProcessor {
  constructor(
    private readonly closedDays: Pick<ClosedDayService, 'finalize'>,
    private readonly detection: Pick<PatternDetectionService, 'runForUser'>,
  ) {}

  async process(userId: string, localDate: string): Promise<DetectionRunResult> {
    await this.closedDays.finalize(userId, localDate);
    return this.detection.runForUser(userId, localDate);
  }
}
