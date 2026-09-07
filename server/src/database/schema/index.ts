/**
 * Drizzle table definitions — the source of truth for the schema
 * (DATABASE_DESIGN.md §7).
 *
 * Deliberately empty in Phase 1. The Planned-vs-Actual spine (`users`,
 * `daily_plans`, `plan_items`, `daily_events`, `meals`, …) lands in Phase 2, where
 * it can be built and policy-tested as one coherent unit rather than accreted.
 * Until then `npm run db:generate` has nothing to generate, and the only migration
 * is the hand-written extension bootstrap.
 */

export {};
