-- RLS for `idempotency_keys` (API_DESIGN.md §1, DATABASE_DESIGN.md §6).
--
-- Hand-written and separate from 0015 for the same reason as 0011 and 0013:
-- `drizzle-kit generate` owns 0015 and knows nothing about policies.
--
-- The owner may read their own rows and nobody may write one through PostgREST. A key row
-- is the server's record of what a write answered; a user able to insert one could make a
-- later request "replay" a response that was never produced. The backend connects as the
-- table owner and is not filtered by this policy; `IdempotencyRepository` scopes every
-- access to the authenticated user.

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own_idempotency_keys_read" ON "idempotency_keys"
  FOR SELECT
  USING ("user_id" = auth.uid());
