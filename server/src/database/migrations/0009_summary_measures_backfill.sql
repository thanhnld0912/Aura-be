-- Backfill for 0008: rewrite the four measures that used to default to 0
-- (PATTERN_ENGINE.md §2.1, DATABASE_DESIGN.md §3.11).
--
-- Hand-written and separate from 0008 for the same reason 0005 and 0007 are separate:
-- `drizzle-kit generate` owns 0008 and would drop anything added to it on regeneration.
--
-- Every value is recomputed from the source tables with the same rule the application
-- now applies on write (`DailySummariesRepository.dayFacts`, `DailyEventsRepository.dayStats`),
-- so a row backfilled here and a row recomputed tomorrow cannot disagree:
--
--   water_ml            sum of `metrics.ml` on the day's live water events; NULL when none has one
--   distinct_foods      distinct resolved foods in the day's confirmed meals; NULL when none
--   vegetable_servings  NULL — no document defines a serving, so no historical value exists
--   protein_servings    NULL — as above
--
-- Nothing is invented: a day whose source rows do not say, stays NULL. The statement is a
-- pure function of the source tables, so running it twice leaves the same result.
--
-- The derived day facts in `metrics` (workout, planned workout time, logging gap) are not
-- backfilled here. An absent key reads as "not computed", i.e. missing, and each day gains
-- them on its next recompute.

UPDATE "daily_summaries" AS s
SET
  "water_ml" = (
    SELECT sum((e."metrics" ->> 'ml')::numeric)
    FROM "daily_events" AS e
    WHERE e."user_id" = s."user_id"
      AND e."local_date" = s."local_date"
      AND e."type" = 'water'
      AND e."deleted_at" IS NULL
  ),
  "distinct_foods" = (
    SELECT nullif(count(DISTINCT mi."food_id"), 0)::int
    FROM "meals" AS m
    JOIN "daily_events" AS e ON e."id" = m."event_id"
    JOIN "meal_items" AS mi ON mi."meal_id" = m."id"
    WHERE m."user_id" = s."user_id"
      AND e."local_date" = s."local_date"
      AND m."status" = 'confirmed'
      AND m."deleted_at" IS NULL
      AND e."deleted_at" IS NULL
  ),
  "vegetable_servings" = NULL,
  "protein_servings" = NULL;
