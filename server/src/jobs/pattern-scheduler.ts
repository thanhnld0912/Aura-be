import type { Env } from '../config/env.js';
import type { Database } from '../database/client.js';
import { DailyEventsRepository } from '../modules/daily-events/daily-events.repository.js';
import { DailyEventsService, type DayRefresher } from '../modules/daily-events/daily-events.service.js';
import { DailyPlansRepository } from '../modules/daily-plans/daily-plans.repository.js';
import { DailyPlansService } from '../modules/daily-plans/daily-plans.service.js';
import { ClosedDayPatternProcessor } from '../modules/patterns/closed-day-pattern-processor.js';
import { PatternDetectionService } from '../modules/patterns/pattern-detection.service.js';
import { PatternsRepository } from '../modules/patterns/patterns.repository.js';
import { ClosedDayService } from '../modules/summaries/closed-day.service.js';
import { DailySummariesRepository } from '../modules/summaries/daily-summaries.repository.js';
import { DayService } from '../modules/summaries/day.service.js';
import { UsersRepository } from '../modules/users/users.repository.js';
import { DailyTrigger } from './daily-trigger.js';
import { NightlyPatternDetection, type JobLogger } from './nightly-pattern-detection.js';

/**
 * When the nightly run fires, in `CRON_TIMEZONE` (DEPLOYMENT.md §6: "02:15 run pattern
 * detectors"). Each user's day is finalised immediately before it is detected, inside the
 * same run (D15) — there is no separate 02:00 job to race against. Per-user dates do not
 * depend on this time; only when the run starts does.
 */
export const PATTERN_DETECTION_AT = '02:15';

export interface ClosedDayPipeline {
  users: UsersRepository;
  processor: ClosedDayPatternProcessor;
}

/**
 * The closed-day pipeline from the existing repositories and services, wired the way the
 * API wires them (`routes/index.ts`): the day refresher is the same `DayService` every write
 * uses. Shared by the nightly job and the backfill. Starts nothing.
 */
export function createClosedDayPipeline(
  database: Database,
  logger: JobLogger,
  now: () => Date = () => new Date(),
): ClosedDayPipeline {
  const db = database.db;
  const users = new UsersRepository(db);
  const summaries = new DailySummariesRepository(db);
  // Declared before it is constructed so the refresher can close over it, as in the API.
  let days: DayService;
  const refresher: DayRefresher = {
    async refresh(userId, localDate, timeZone) {
      await days.refresh(userId, localDate, timeZone);
    },
  };
  const events = new DailyEventsService(new DailyEventsRepository(db), () => refresher, now);
  days = new DayService(new DailyPlansService(new DailyPlansRepository(db), events, now), events, summaries);

  const detection = new PatternDetectionService({ users, summaries, patterns: new PatternsRepository(db), logger, now });
  const processor = new ClosedDayPatternProcessor(new ClosedDayService(users, days, now), detection);
  return { users, processor };
}

export interface PatternScheduler {
  /** The job, for a test or an operator to run directly. */
  job: NightlyPatternDetection;
  trigger: DailyTrigger;
}

/** Wires the nightly job and its trigger. Starts nothing. */
export function createPatternScheduler(env: Env, database: Database, logger: JobLogger): PatternScheduler {
  const { users, processor } = createClosedDayPipeline(database, logger);
  const job = new NightlyPatternDetection({ users, processor, logger });
  const trigger = new DailyTrigger({
    at: PATTERN_DETECTION_AT,
    timeZone: env.CRON_TIMEZONE,
    task: (firedAt) => job.run(firedAt),
    logger,
  });
  return { job, trigger };
}
