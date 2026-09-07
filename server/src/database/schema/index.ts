/**
 * Drizzle table definitions — the source of truth for the schema
 * (DATABASE_DESIGN.md §7). `drizzle-kit generate` diffs these into reviewed SQL;
 * nothing is ever pushed straight at a database.
 *
 * Row Level Security is deliberately **not** declared here. It is managed by the
 * hand-written migrations `0002_auth_uid_shim` and `0003_rls_policies`, because the
 * policies depend on `auth.uid()` — a Supabase function that has to be shimmed on
 * plain PostgreSQL, which is not something a schema diff can express.
 */

export * from './enums.js';
export * from './users.js';
export * from './events.js';
export * from './plans.js';
export * from './checkins.js';
export * from './foods.js';
export * from './meals.js';
export * from './workouts.js';
export * from './habits.js';
export * from './summaries.js';
