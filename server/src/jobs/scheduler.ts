import Fastify from 'fastify';
import { EnvValidationError, getEnv } from '../config/env.js';
import { createDatabase } from '../database/client.js';
import { loggerOptions } from '../lib/logger.js';
import { PATTERN_DETECTION_AT, createPatternScheduler } from './pattern-scheduler.js';

/**
 * Scheduled-jobs entrypoint (DEPLOYMENT.md §6): `node dist/jobs/scheduler.js`, the same image
 * as the API, run as its own process so the API's replicas never each start a scheduler.
 *
 * Starts only with `CRON_ENABLED=true`; otherwise it logs that and exits cleanly. Today it
 * runs one job, nightly pattern detection. SIGINT/SIGTERM stop the trigger, wait for a run in
 * progress to finish, and close the database.
 */
async function main(): Promise<void> {
  const env = getEnv();
  // The API's own logger configuration — same JSON shape and redaction — without a server.
  const logger = Fastify({ logger: loggerOptions(env) }).log;

  if (!env.CRON_ENABLED) {
    logger.info('CRON_ENABLED is false; the scheduler is not started');
    return;
  }

  const database = createDatabase(env);
  const { trigger } = createPatternScheduler(env, database, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'scheduler shutting down');
    try {
      await trigger.stop();
      await database.close();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'scheduler shutdown failed');
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  trigger.start();
  logger.info({ at: PATTERN_DETECTION_AT, timeZone: env.CRON_TIMEZONE }, 'scheduler started: nightly pattern detection');
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
  } else {
    console.error('Failed to start AURA scheduler:', error);
  }
  process.exit(1);
});
