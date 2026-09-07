-- RLS for the one user-owned table Phase 3 adds (DATABASE_DESIGN.md §6).
--
-- Same shape as every other owned table: FOR ALL with USING and WITH CHECK, so a leaked
-- anon key reaching PostgREST sees only its own rows and cannot write an alias onto
-- somebody else's account. Without it, `user_food_aliases` would be the one table in the
-- schema readable by anyone — and it holds the phrases a user actually types.

ALTER TABLE "user_food_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_food_aliases" ON "user_food_aliases"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());
