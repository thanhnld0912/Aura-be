import { defineConfig } from 'drizzle-kit';

// Drizzle Kit *generates* SQL; it never applies it (DATABASE_DESIGN.md §7).
// Migrations are reviewed, committed, and applied by `npm run db:migrate`
// as a release command — never by `drizzle-kit push`, and never at app boot.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: true,
});
