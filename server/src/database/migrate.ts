import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { z } from 'zod';

/**
 * Applies committed SQL migrations. Run as a *release command* before the new
 * container takes traffic — never at application boot, because two instances
 * racing `db:migrate` on startup is a corruption path (DEPLOYMENT.md §5).
 *
 * Resolves the migrations folder relative to this file so it works both under
 * `tsx` (src) and from the built output (dist, where the build copies the SQL).
 */
const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Deliberately narrower than the application's config schema. Applying migrations needs
 * a database and nothing else — it should not fail because an API key the *server*
 * requires happens to be absent from the release environment, and a migration runner
 * that demands the full app config is a coupling that bites exactly when you least
 * want it to.
 */
const migrationEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const env = migrationEnvSchema.parse(process.env);
  // A single connection: migrations are serial, and advisory locking is per-session.
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    console.log(`Applying migrations from ${migrationsFolder}`);
    await migrate(drizzle(sql), { migrationsFolder });
    console.log('Migrations applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
