-- RLS for `patterns` (DATABASE_DESIGN.md §3.7, §6).
--
-- Hand-written and separate from 0010 for the same reason 0005, 0007 and 0009 are separate:
-- `drizzle-kit generate` owns 0010 and knows nothing about policies.
--
-- **Read-only for the owner — no write policy at all.** Every other owned table carries one
-- FOR ALL policy, because a user writes those rows. Nobody writes a pattern except the
-- engine: it is a statistical claim, and if a leaked anon key carrying a user's own JWT
-- could insert or update one, that user could plant a "pattern" — a strength, a p-value,
-- evidence — that later reaches the story and narration as if the engine had found it.
-- With RLS enabled and only a SELECT policy, INSERT, UPDATE and DELETE through PostgREST
-- are denied for every row; dismissal goes through the API. This is the `foods` shape
-- (readable, no write policy), applied to an owned table.
--
-- What this does not do: the backend connects as the table owner (service_role on
-- Supabase, which also holds BYPASSRLS), and FORCE ROW LEVEL SECURITY is deliberately not
-- set (0003). The policy does not filter the backend's queries; `PatternsRepository`
-- scopes every one of them to the userId it is given, which the API takes from the
-- verified token and the engine from its own iteration over users.

ALTER TABLE "patterns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_patterns_read" ON "patterns"
  FOR SELECT
  USING ("user_id" = auth.uid());
