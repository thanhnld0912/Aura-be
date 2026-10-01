import { ulid } from 'ulid';
import { ValidationError } from '../lib/errors.js';
import { LOCAL_DATE_PATTERN, addLocalDays } from '../lib/local-date.js';
import type { ClosedDayPatternProcessor } from '../modules/patterns/closed-day-pattern-processor.js';
import type { UsersRepository } from '../modules/users/users.repository.js';
import { USER_PAGE_SIZE, closedDayFor, type JobLogger } from './nightly-pattern-detection.js';

/**
 * Historical backfill: finalise and detect a range of closed days, per user, oldest first
 * (PATTERN_ENGINE.md §4, D15, D17). Invoked explicitly — `npm run patterns:backfill` — and
 * never by the API, the scheduler or a build.
 *
 * ## Semantics
 *
 * - `from`..`to` is a range of **local calendar dates**, read in each user's own timezone;
 *   nothing is converted through UTC. `to` defaults to each user's most recently closed day.
 * - Days that are not closed for a user — their today and later — are never processed; they
 *   are counted as skipped. The closed-day rule itself is the one `ClosedDayService` and
 *   `PatternDetectionService` enforce.
 * - Each user's days run in **chronological order**, each through
 *   `ClosedDayPatternProcessor.process`: finalise the day, then detect on it.
 * - A day before the user's watermark is finalised and detected but changes no pattern
 *   (`historical`): older evidence never overrides what a newer run decided. To recompute
 *   the current patterns from corrected history, let the range reach the latest closed day.
 * - A failing day is recorded with its user, date and error, and the backfill moves on to
 *   the next day and the next user. Every successful day is already committed, so a re-run
 *   repeats what is needed and converges: the same range twice gives the same patterns.
 */

export interface BackfillRequest {
  from: string;
  /** Inclusive. Defaults to each user's most recently closed day. */
  to?: string;
  /** Only these users; every active user when absent. */
  userIds?: readonly string[];
}

export interface BackfillFailure {
  userId: string;
  /** Null when the failure concerns the user rather than a day (e.g. not found). */
  localDate: string | null;
  error: { name: string; message: string };
}

export interface BackfillResult {
  runId: string;
  startedAt: Date;
  durationMs: number;
  users: number;
  daysProcessed: number;
  /** Processed, but before the user's watermark: finalised, no pattern changed. */
  daysHistorical: number;
  daysFailed: number;
  /** In the range but not closed for that user: not processed. */
  daysSkipped: number;
  failures: BackfillFailure[];
}

export interface PatternBackfillDeps {
  users: Pick<UsersRepository, 'listActiveTimezones' | 'findActiveById'>;
  processor: Pick<ClosedDayPatternProcessor, 'process'>;
  logger: JobLogger;
  clock?: () => number;
}

export class PatternBackfill {
  private readonly clock: () => number;

  constructor(private readonly deps: PatternBackfillDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  async run(request: BackfillRequest, now: Date): Promise<BackfillResult> {
    validateRange(request);
    const runId = ulid();
    const started = this.clock();
    const result: BackfillResult = {
      runId,
      startedAt: now,
      durationMs: 0,
      users: 0,
      daysProcessed: 0,
      daysHistorical: 0,
      daysFailed: 0,
      daysSkipped: 0,
      failures: [],
    };
    this.deps.logger.info(
      { runId, from: request.from, to: request.to ?? null, users: request.userIds?.length ?? 'all' },
      'pattern backfill started',
    );

    for await (const user of this.targets(request, result)) {
      result.users += 1;
      await this.backfillUser(user, request, now, result);
    }

    result.durationMs = this.clock() - started;
    const { failures, ...counts } = result;
    this.deps.logger.info({ ...counts, startedAt: now.toISOString(), failures: failures.length }, 'pattern backfill complete');
    return result;
  }

  private async backfillUser(
    user: { id: string; timezone: string },
    request: BackfillRequest,
    now: Date,
    result: BackfillResult,
  ): Promise<void> {
    let lastClosed: string;
    try {
      lastClosed = closedDayFor(user.timezone, now);
    } catch (error) {
      this.fail(result, user.id, null, error);
      return;
    }

    const requestedEnd = request.to ?? lastClosed;
    const end = requestedEnd < lastClosed ? requestedEnd : lastClosed;
    for (let day = addLocalDays(end, 1); day <= requestedEnd; day = addLocalDays(day, 1)) result.daysSkipped += 1;

    for (let day = request.from; day <= end; day = addLocalDays(day, 1)) {
      try {
        const run = await this.deps.processor.process(user.id, day);
        result.daysProcessed += 1;
        if (run.historical) result.daysHistorical += 1;
      } catch (error) {
        result.daysFailed += 1;
        this.fail(result, user.id, day, error);
      }
    }
  }

  /** The users to process: the named ones (each must be active), or every active user. */
  private async *targets(request: BackfillRequest, result: BackfillResult): AsyncGenerator<{ id: string; timezone: string }> {
    if (request.userIds) {
      for (const id of request.userIds) {
        const user = await this.deps.users.findActiveById(id);
        if (user) yield { id: user.id, timezone: user.timezone };
        else this.fail(result, id, null, new ValidationError('User not found or not active'));
      }
      return;
    }
    let afterId: string | null = null;
    for (;;) {
      const page = await this.deps.users.listActiveTimezones(afterId, USER_PAGE_SIZE);
      yield* page;
      if (page.length < USER_PAGE_SIZE) return;
      afterId = page[page.length - 1]!.id;
    }
  }

  private fail(result: BackfillResult, userId: string, localDate: string | null, error: unknown): void {
    const described = error instanceof Error ? { name: error.name, message: error.message } : { name: 'NonError', message: String(error) };
    result.failures.push({ userId, localDate, error: described });
    this.deps.logger.error({ runId: result.runId, userId, localDate, err: described }, 'pattern backfill failed for day');
  }
}

/** A well-formed range, refused before anything runs. */
function validateRange(request: BackfillRequest): void {
  const isDate = (value: string) => LOCAL_DATE_PATTERN.test(value) && addLocalDays(value, 0) === value;
  if (!isDate(request.from)) {
    throw new ValidationError('from must be a calendar date', [{ path: 'from', issue: 'invalid_date' }]);
  }
  if (request.to !== undefined && !isDate(request.to)) {
    throw new ValidationError('to must be a calendar date', [{ path: 'to', issue: 'invalid_date' }]);
  }
  if (request.to !== undefined && request.to < request.from) {
    throw new ValidationError('to must not be before from', [{ path: 'to', issue: 'before_from' }]);
  }
}
