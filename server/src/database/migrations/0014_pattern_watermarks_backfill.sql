-- Initial watermarks for users who already have patterns (DATABASE_DESIGN.md §3.7).
--
-- Hand-written and separate from 0012, as 0009 is from 0008. Idempotent: a user who already
-- has a watermark keeps the later of the two dates.
--
-- Before 0012 the latest evaluated day was recorded nowhere. The best fact the data holds is
-- the newest `window_end` among the user's patterns: a run on that day certainly happened and
-- was authoritative. A run that later made a pattern stale, or that found nothing, left no
-- date, so this is a lower bound — never a later date than was really evaluated. Users with
-- no patterns get no row, which means "no authoritative run recorded", exactly as before.
-- (No production environment has run detection yet, so in practice this inserts nothing.)

INSERT INTO "pattern_watermarks" ("user_id", "evaluated_through", "updated_at")
SELECT "user_id", max("window_end"), now()
FROM "patterns"
GROUP BY "user_id"
ON CONFLICT ("user_id") DO UPDATE
  SET "evaluated_through" = GREATEST("pattern_watermarks"."evaluated_through", EXCLUDED."evaluated_through"),
      "updated_at" = now();
