-- Extension bootstrap.
--
-- pg_trgm backs the `gin_trgm_ops` indexes that make fuzzy Vietnamese food matching
-- work (DATABASE_DESIGN.md §4, NUTRITION_ARCHITECTURE.md §4 step 3), and unaccent
-- provides the diacritic stripping those indexes are built over, so that
-- "thit kho", "thịt kho" and "Thịt Kho" all reach the same row.
--
-- Enabled ahead of the tables that use them so a fresh database is ready for the
-- Phase 2 schema without an ordering dependency inside a later migration.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
