-- RLS for `pattern_watermarks` (DATABASE_DESIGN.md §3.7, §6).
--
-- Hand-written and separate from 0012 for the same reason as 0011: `drizzle-kit generate`
-- owns 0012 and knows nothing about policies.
--
-- The same shape as `patterns` (0011): the owner may read their own row and nobody may write
-- one through PostgREST. The watermark is engine state — a user able to move it forward
-- could freeze their own patterns, since every detection for an earlier day would be treated
-- as historical. The backend connects as the table owner and is not filtered by this policy;
-- `PatternsRepository` scopes every access to the user it is processing.

ALTER TABLE "pattern_watermarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_pattern_watermarks_read" ON "pattern_watermarks"
  FOR SELECT
  USING ("user_id" = auth.uid());
