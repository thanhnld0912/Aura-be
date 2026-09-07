-- Row Level Security — the second lock (DATABASE_DESIGN.md §6, SECURITY.md §2).
--
-- The first lock is the repository layer: every query is scoped to the userId taken from
-- the verified JWT, never from request input. The backend connects as the table owner
-- (service_role on Supabase, which additionally holds BYPASSRLS), so these policies do
-- not filter its queries and are not what makes the API safe.
--
-- What they defend is the other door. Supabase's default privileges grant `anon` and
-- `authenticated` access to new tables in `public`, so a leaked anon key can reach these
-- tables through PostgREST. Without RLS that key reads every user's rows. With it, a
-- request carrying no JWT sees nothing (auth.uid() is NULL, and `user_id = NULL` is never
-- true), and a request carrying user A's JWT sees only user A.
--
-- `FORCE ROW LEVEL SECURITY` is deliberately NOT set: forcing it would subject the
-- backend's own connection to the policies, which is precisely the coupling the
-- architecture rejects — authorization would then depend on propagating JWT claims onto
-- pooled connections, a leak hazard between concurrent requests.
--
-- Each policy is FOR ALL with both USING and WITH CHECK, which is exactly equivalent to
-- four separate policies: USING gates the rows SELECT/UPDATE/DELETE can see, WITH CHECK
-- gates the rows INSERT/UPDATE may produce. Writing it once per table keeps the intent
-- auditable at a glance rather than spread over sixty statements.
--
-- Child tables have no user_id by design; they scope through their parent, so a row can
-- never be reachable by a different route than its owner's.

-- ── Directly owned by a user ──────────────────────────────────────────────────
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_user" ON "users"
  USING ("id" = auth.uid()) WITH CHECK ("id" = auth.uid());--> statement-breakpoint

ALTER TABLE "user_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_preferences" ON "user_preferences"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "daily_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_plans" ON "daily_plans"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "daily_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_events" ON "daily_events"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "checkins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_checkins" ON "checkins"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "meals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_meals" ON "meals"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "workout_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_workout_sessions" ON "workout_sessions"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "habits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_habits" ON "habits"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "habit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_habit_logs" ON "habit_logs"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

ALTER TABLE "daily_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_daily_summaries" ON "daily_summaries"
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());--> statement-breakpoint

-- ── Owned through a parent ────────────────────────────────────────────────────
ALTER TABLE "plan_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_plan_items" ON "plan_items"
  USING (EXISTS (SELECT 1 FROM "daily_plans" p
                 WHERE p."id" = "plan_items"."plan_id" AND p."user_id" = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "daily_plans" p
                      WHERE p."id" = "plan_items"."plan_id" AND p."user_id" = auth.uid()));--> statement-breakpoint

ALTER TABLE "meal_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_meal_items" ON "meal_items"
  USING (EXISTS (SELECT 1 FROM "meals" m
                 WHERE m."id" = "meal_items"."meal_id" AND m."user_id" = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "meals" m
                      WHERE m."id" = "meal_items"."meal_id" AND m."user_id" = auth.uid()));--> statement-breakpoint

ALTER TABLE "workout_exercises" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_workout_exercises" ON "workout_exercises"
  USING (EXISTS (SELECT 1 FROM "workout_sessions" s
                 WHERE s."id" = "workout_exercises"."session_id" AND s."user_id" = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "workout_sessions" s
                      WHERE s."id" = "workout_exercises"."session_id"
                        AND s."user_id" = auth.uid()));--> statement-breakpoint

-- ── Public reference data ─────────────────────────────────────────────────────
-- `foods` and `food_portions` are shared nutrition reference data, not user content
-- (DATABASE_DESIGN.md §3.6, §6). Readable by anyone; writable only by the backend, which
-- owns the tables — there is no write policy, so a non-owner role cannot insert or update
-- even though it can read.
ALTER TABLE "foods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "foods_readable" ON "foods" FOR SELECT USING (true);--> statement-breakpoint

ALTER TABLE "food_portions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "food_portions_readable" ON "food_portions" FOR SELECT USING (true);
