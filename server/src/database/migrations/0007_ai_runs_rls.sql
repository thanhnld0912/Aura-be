-- RLS for the one user-owned table Phase 4 Task 2 adds (DATABASE_DESIGN.md §6).
--
-- Hand-written and separate from 0006 for the same reason 0005 was separate from 0004:
-- `drizzle-kit generate` diffs the schema and knows nothing about policies, so anything
-- written into a generated file is lost the next time that file is regenerated.
--
-- Same shape as every other owned table: FOR ALL with USING and WITH CHECK, so a leaked
-- anon key reaching PostgREST sees only its own runs and cannot attribute a call to
-- somebody else's account. `ai_runs` is a cost ledger keyed by user, so without this it
-- would be the one table in the schema that lets an outsider read who is using the
-- product and how much.

ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_ai_runs" ON "ai_runs"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());
