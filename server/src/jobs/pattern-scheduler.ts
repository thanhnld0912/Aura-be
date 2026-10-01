import type { Env } from '../config/env.js';
import type { Database } from '../database/client.js';
import { PatternDetectionService } from '../modules/patterns/pattern-detection.service.js';
import { PatternsRepository } from '../modules/patterns/patterns.repository.js';
import { DailySummariesRepository } from '../modules/summaries/daily-summaries.repository.js';
import { UsersRepository } from '../modules/users/users.repository.js';
import { DailyTrigger } from './daily-trigger.js';
import { NightlyPatternDetection, type JobLogger } from './nightly-pattern-detection.js';

/**
 * When the nightly run fires, in `CRON_TIMEZONE` (DEPLOYMENT.md §6: "02:15 run pattern
 * detectors"). Per-user dates do not depend on it — each user's closed day is computed in
 * their own timezone — only when the run starts does.
 */
export const PATTERN_DETECTION_AT = '02:15';

export interface PatternScheduler {
  /** The job, for a test or an operator to run directly. */
  job: NightlyPatternDetection;
  trigger: DailyTrigger;
}

/** Wires the nightly job from the existing repositories and service. Starts nothing. */
export function createPatternScheduler(env: Env, database: Database, logger: JobLogger): PatternScheduler {
  const db = database.db;
  const users = new UsersRepository(db);
  const detection = new PatternDetectionService({
    users,
    summaries: new DailySummariesRepository(db),
    patterns: new PatternsRepository(db),
    logger,
  });
  const job = new NightlyPatternDetection({ users, detection, logger });
  const trigger = new DailyTrigger({
    at: PATTERN_DETECTION_AT,
    timeZone: env.CRON_TIMEZONE,
    task: (firedAt) => job.run(firedAt),
    logger,
  });
  return { job, trigger };
}
