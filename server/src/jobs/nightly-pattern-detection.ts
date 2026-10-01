import { ulid } from 'ulid';
import { NotFoundError } from '../lib/errors.js';
import { addLocalDays, todayIn } from '../lib/local-date.js';
import type { PatternDetectionService } from '../modules/patterns/pattern-detection.service.js';
import type { UsersRepository } from '../modules/users/users.repository.js';

/**
 * The nightly pattern detection job (DEPLOYMENT.md §6, PATTERN_ENGINE_DECISIONS.md D11).
 *
 * One global run walks every active user and asks `PatternDetectionService.runForUser` to
 * process **that user's** most recently closed local day: yesterday in the user's own
 * timezone, from one instant fixed at the start of the run. It decides who and which day,
 * and nothing else — features, detectors, persistence and reconciliation are the
 * service's.
 *
 * - **Sequential.** Users are processed one at a time, in pages of `USER_PAGE_SIZE`. A run is
 *   a few indexed reads and writes per user; one at a time keeps the database load flat, and
 *   a run that overlaps another is serialised per user by the service's advisory lock.
 * - **Failure isolation.** A user whose run throws is counted as failed and logged with the
 *   error's name and message; the run moves on. A user who stopped being active between the
 *   page read and their turn is skipped. The job itself throws only if it cannot list users —
 *   that is a failed run, never "zero users".
 * - **Idempotent.** Running it again for the same night leaves the same patterns: the service
 *   and `(user_id, key)` see to that. There is no run ledger.
 */

export const USER_PAGE_SIZE = 500;

/** The day a nightly run processes for a user: the day before their local today. */
export function closedDayFor(timeZone: string, now: Date): string {
  return addLocalDays(todayIn(timeZone, now), -1);
}

export interface NightlyRunResult {
  runId: string;
  startedAt: Date;
  durationMs: number;
  targetedUsers: number;
  succeededUsers: number;
  failedUsers: number;
  /** No longer active when their turn came. */
  skippedUsers: number;
}

export interface JobLogger {
  info(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface NightlyPatternDetectionDeps {
  users: Pick<UsersRepository, 'listActiveTimezones'>;
  detection: Pick<PatternDetectionService, 'runForUser'>;
  logger: JobLogger;
  pageSize?: number;
  /** Monotonic-enough clock for the duration; the run's instant is passed to `run`. */
  clock?: () => number;
}

export class NightlyPatternDetection {
  private readonly pageSize: number;
  private readonly clock: () => number;

  constructor(private readonly deps: NightlyPatternDetectionDeps) {
    this.pageSize = deps.pageSize ?? USER_PAGE_SIZE;
    this.clock = deps.clock ?? Date.now;
  }

  async run(now: Date): Promise<NightlyRunResult> {
    const runId = ulid();
    const started = this.clock();
    const counts = { targetedUsers: 0, succeededUsers: 0, failedUsers: 0, skippedUsers: 0 };
    this.deps.logger.info({ runId, triggeredAt: now.toISOString() }, 'nightly pattern detection started');

    try {
      let afterId: string | null = null;
      for (;;) {
        const page = await this.deps.users.listActiveTimezones(afterId, this.pageSize);
        for (const user of page) {
          counts.targetedUsers += 1;
          let targetDate: string | undefined;
          try {
            targetDate = closedDayFor(user.timezone, now);
            await this.deps.detection.runForUser(user.id, targetDate);
            counts.succeededUsers += 1;
          } catch (error) {
            if (error instanceof NotFoundError) {
              counts.skippedUsers += 1;
              continue;
            }
            counts.failedUsers += 1;
            this.deps.logger.error(
              { runId, userId: user.id, targetDate, err: describe(error) },
              'nightly pattern detection failed for user',
            );
          }
        }
        if (page.length < this.pageSize) break;
        afterId = page[page.length - 1]!.id;
      }
    } catch (error) {
      this.deps.logger.error({ runId, ...counts, err: describe(error) }, 'nightly pattern detection run failed');
      throw error;
    }

    const result: NightlyRunResult = { runId, startedAt: now, durationMs: this.clock() - started, ...counts };
    this.deps.logger.info({ ...result, startedAt: now.toISOString() }, 'nightly pattern detection complete');
    return result;
  }
}

/** The error's name and message — never a stack with data in it, never the user's records. */
function describe(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'NonError', message: String(error) };
}
