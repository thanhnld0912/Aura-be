import { parseArgs } from 'node:util';
import Fastify from 'fastify';
import { EnvValidationError, getEnv } from '../config/env.js';
import { createDatabase } from '../database/client.js';
import { ValidationError } from '../lib/errors.js';
import { loggerOptions } from '../lib/logger.js';
import { PatternBackfill } from './pattern-backfill.js';
import { createClosedDayPipeline } from './pattern-scheduler.js';

/**
 * Pattern backfill CLI — run by an operator, never automatically.
 *
 *   npm run patterns:backfill -- --from 2026-09-01 [--to 2026-09-30] [--user <uuid> ...]
 *   npm run patterns:backfill:dist -- …   (the built image: node dist/jobs/backfill.js)
 *
 * Dates are local calendar dates in each user's timezone. Exits 0 when every day succeeded,
 * 1 when any day or user failed (the failures are in the final log line) or the run could not
 * proceed, 2 on bad arguments.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      user: { type: 'string', multiple: true },
    },
    strict: true,
  });
  if (!values.from) {
    console.error('usage: patterns:backfill --from YYYY-MM-DD [--to YYYY-MM-DD] [--user <uuid> ...]');
    return 2;
  }

  const env = getEnv();
  const logger = Fastify({ logger: loggerOptions(env) }).log;
  const database = createDatabase(env);
  try {
    const { users, processor } = createClosedDayPipeline(database, logger);
    const backfill = new PatternBackfill({ users, processor, logger });
    const result = await backfill.run(
      {
        from: values.from,
        ...(values.to ? { to: values.to } : {}),
        ...(values.user ? { userIds: values.user } : {}),
      },
      new Date(),
    );
    logger.info({ failures: result.failures }, 'pattern backfill failures');
    return result.failures.length === 0 ? 0 : 1;
  } finally {
    await database.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof EnvValidationError) console.error(error.message);
    else console.error('Pattern backfill failed:', error instanceof Error ? error.message : error);
    // Arguments the backfill refused (a malformed or reversed range) are a usage error.
    process.exit(error instanceof ValidationError || error instanceof TypeError ? 2 : 1);
  });
