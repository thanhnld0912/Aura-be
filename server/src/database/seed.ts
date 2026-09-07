import { config as loadDotenv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from './schema/index.js';
import { seedFoods } from './seeds/seed-foods.js';

/**
 * Loads reference data. Idempotent, so it is safe to run on every deploy.
 *
 * Kept separate from migrations on purpose: a migration changes the shape of the
 * database and must run exactly once, while seeding refreshes content that is expected
 * to be corrected over time. Conflating them would mean a food's improved figure needed
 * a schema migration to ship.
 *
 * Like the migration runner, this parses only `DATABASE_URL` — seeding foods has no
 * business failing because an AI key is absent.
 */
const seedEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const env = seedEnvSchema.parse(process.env);

  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const db = drizzle(sql, { schema });
    const result = await seedFoods(db);
    console.log(
      `Seeded ${result.foodsUpserted} foods and ${result.portionsUpserted} portions ` +
        `into the local Vietnamese dataset.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('Seeding failed:', error);
  process.exitCode = 1;
});
