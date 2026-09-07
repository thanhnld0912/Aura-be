-- auth.uid() portability shim.
--
-- The RLS policies in 0003 are written against Supabase's `auth.uid()`, which reads the
-- verified JWT claims PostgREST sets on the connection. Plain PostgreSQL — local Docker
-- and CI — has no `auth` schema and no such function, so the same policies could not be
-- applied, let alone tested, without this.
--
-- On Supabase both the schema and the function already exist and this migration is a
-- no-op: the guard checks for the function rather than replacing it, so we never clobber
-- the platform's own implementation.
--
-- The definition matches Supabase's: the `sub` claim of `request.jwt.claims`, or NULL when
-- no claim is set. NULL is the important case — it is what an unauthenticated connection
-- gets, and `user_id = NULL` is never true, so every policy denies by default.

CREATE SCHEMA IF NOT EXISTS auth;
--> statement-breakpoint
DO $do$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql
      STABLE
    AS $fn$
      SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $fn$;
  END IF;
END
$do$;
