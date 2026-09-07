import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { getEnv } from '../config/env.js';

/**
 * Applies committed SQL migrations. Run as a *release command* before the new
 * container takes traffic — never at application boot, because two instances
 * racing `db:migrate` on startup is a corruption path (DEPLOYMENT.md §5).
 *
 * Resolves the migrations folder relative to this file so it works both under
 * `tsx` (src) and from the built output (dist, where the build copies the SQL).
 */
const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

async function main(): Promise<void> {
  const env = getEnv();
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
