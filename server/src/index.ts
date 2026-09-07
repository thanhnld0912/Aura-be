import { buildApp } from './app.js';
import { EnvValidationError, getEnv } from './config/env.js';
import { createDatabase } from './database/client.js';

/**
 * Process entrypoint. Migrations are **not** run here — they are a release command
 * executed before the new container takes traffic (DEPLOYMENT.md §5).
 */
async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const app = await buildApp({ env, database });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await database.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // Fail loudly and readably rather than surfacing an undefined key on the first
    // user request an hour later (DEPLOYMENT.md §3).
    console.error(error.message);
  } else {
    console.error('Failed to start AURA server:', error);
  }
  process.exit(1);
});
