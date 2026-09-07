CREATE TABLE "user_food_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"alias_normalized" text NOT NULL,
	"food_id" uuid NOT NULL,
	"default_grams" numeric(8, 2),
	"use_count" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_alias_grams" CHECK ("user_food_aliases"."default_grams" is null or "user_food_aliases"."default_grams" > 0)
);
--> statement-breakpoint
DROP INDEX "idx_foods_name_trgm";--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "search_name" text;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "search_name_en" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "source_reference" text;--> statement-breakpoint
ALTER TABLE "foods" ADD COLUMN "search_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfilled rather than added NOT NULL outright: foods is empty in every environment
-- today, but a bare ADD COLUMN ... NOT NULL with no default fails the moment it is not,
-- and a migration that only works on an empty table is a trap for staging. unaccent is
-- STABLE, which is fine in a one-shot UPDATE even though it cannot back an index; the
-- Vietnamese d-stroke is not a diacritic composition, so it needs the explicit translate.
UPDATE "foods" SET "search_name" = translate(unaccent(lower("canonical_name")), CHR(273) || CHR(272), CHR(100) || CHR(100))
  WHERE "search_name" IS NULL;--> statement-breakpoint
ALTER TABLE "foods" ALTER COLUMN "search_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_items" ADD COLUMN "portion_id" uuid;--> statement-breakpoint
ALTER TABLE "user_food_aliases" ADD CONSTRAINT "user_food_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_food_aliases" ADD CONSTRAINT "user_food_aliases_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alias_user_phrase" ON "user_food_aliases" USING btree ("user_id","alias_normalized");--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_portion_id_food_portions_id_fk" FOREIGN KEY ("portion_id") REFERENCES "public"."food_portions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_foods_search_trgm" ON "foods" USING gin ("search_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_foods_search_en_trgm" ON "foods" USING gin ("search_name_en" gin_trgm_ops);