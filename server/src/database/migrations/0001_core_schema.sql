CREATE TYPE "public"."adherence" AS ENUM('pending', 'on_time', 'shifted', 'substituted', 'not_logged');--> statement-breakpoint
CREATE TYPE "public"."data_quality" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."day_tag" AS ENUM('normal', 'busy', 'better_than_expected', 'not_as_planned');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('user', 'ai', 'imported');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('meal', 'workout', 'walk', 'sleep', 'water', 'habit', 'checkin', 'custom');--> statement-breakpoint
CREATE TYPE "public"."food_provider" AS ENUM('usda', 'off', 'local');--> statement-breakpoint
CREATE TYPE "public"."goal_focus" AS ENUM('consistency', 'variety', 'movement');--> statement-breakpoint
CREATE TYPE "public"."habit_cadence" AS ENUM('daily', 'weekly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."habit_log_status" AS ENUM('done', 'partial', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."input_method" AS ENUM('photo', 'text', 'quick', 'manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('vi', 'en');--> statement-breakpoint
CREATE TYPE "public"."meal_item_unit" AS ENUM('g', 'ml', 'bowl', 'piece', 'plate', 'serving');--> statement-breakpoint
CREATE TYPE "public"."meal_status" AS ENUM('draft', 'confirmed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."meal_type" AS ENUM('breakfast', 'lunch', 'dinner', 'snack', 'drink');--> statement-breakpoint
CREATE TYPE "public"."mood" AS ENUM('low', 'okay', 'good', 'great');--> statement-breakpoint
CREATE TYPE "public"."nutrition_display" AS ENUM('focus', 'detail', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."nutrition_source" AS ENUM('vision', 'text', 'quick', 'usda', 'off', 'local', 'user', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."plan_source" AS ENUM('user', 'ai', 'template');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."portion_label" AS ENUM('small', 'medium', 'large', 'custom');--> statement-breakpoint
CREATE TYPE "public"."skip_reason" AS ENUM('busy', 'tired', 'no_time', 'not_motivated', 'other');--> statement-breakpoint
CREATE TYPE "public"."unit_system" AS ENUM('metric', 'imperial');--> statement-breakpoint
CREATE TYPE "public"."workout_status" AS ENUM('completed', 'partial', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."workout_type" AS ENUM('gym', 'run', 'walk', 'yoga', 'sport', 'home', 'other');--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"unit_system" "unit_system" DEFAULT 'metric' NOT NULL,
	"show_calories" boolean DEFAULT true NOT NULL,
	"nutrition_display" "nutrition_display" DEFAULT 'focus' NOT NULL,
	"dietary_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disliked_foods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goal_focus" "goal_focus" DEFAULT 'consistency' NOT NULL,
	"quiet_hours_start" time,
	"quiet_hours_end" time,
	"ai_insights_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"timezone" text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	"locale" "locale" DEFAULT 'vi' NOT NULL,
	"date_of_birth" date,
	"streak_days" integer DEFAULT 0 NOT NULL,
	"streak_last_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "daily_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"type" "event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"duration_min" integer,
	"title" text NOT NULL,
	"note" text,
	"input_method" "input_method" DEFAULT 'manual' NOT NULL,
	"source" "event_source" DEFAULT 'user' NOT NULL,
	"metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "daily_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"source" "plan_source" DEFAULT 'user' NOT NULL,
	"status" "plan_status" DEFAULT 'active' NOT NULL,
	"generated_by_ai_run" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"event_type" "event_type" NOT NULL,
	"title" text NOT NULL,
	"planned_time" time NOT NULL,
	"planned_duration_min" integer,
	"target" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"linked_event_id" uuid,
	"adherence" "adherence" DEFAULT 'pending' NOT NULL,
	"shift_minutes" integer,
	"reconciled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"mood" "mood" NOT NULL,
	"day_tag" "day_tag",
	"energy_1_5" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkins_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "food_portions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"label" text NOT NULL,
	"label_vi" text,
	"grams" numeric(8, 2) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "chk_portion_grams" CHECK ("food_portions"."grams" > 0)
);
--> statement-breakpoint
CREATE TABLE "foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"name_vi" text,
	"name_en" text NOT NULL,
	"provider" "food_provider" NOT NULL,
	"external_id" text NOT NULL,
	"barcode" text,
	"category" text,
	"kcal_per_100g" numeric(8, 2),
	"protein_per_100g" numeric(8, 2),
	"carbs_per_100g" numeric(8, 2),
	"fat_per_100g" numeric(8, 2),
	"fiber_per_100g" numeric(8, 2),
	"micronutrients" jsonb,
	"data_quality" "data_quality" DEFAULT 'medium' NOT NULL,
	"search_vector" "tsvector",
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_food_kcal_nonneg" CHECK ("foods"."kcal_per_100g" is null or "foods"."kcal_per_100g" >= 0)
);
--> statement-breakpoint
CREATE TABLE "meal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_id" uuid NOT NULL,
	"food_id" uuid,
	"detected_name" text NOT NULL,
	"display_name_vi" text,
	"display_name_en" text,
	"quantity" numeric(8, 3) NOT NULL,
	"unit" "meal_item_unit" NOT NULL,
	"grams_resolved" numeric(8, 2),
	"portion_label" "portion_label",
	"kcal" numeric(8, 2),
	"protein_g" numeric(8, 2),
	"carbs_g" numeric(8, 2),
	"fat_g" numeric(8, 2),
	"fiber_g" numeric(8, 2),
	"source" "nutrition_source" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"user_confirmed" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_confidence" CHECK ("meal_items"."confidence" >= 0 and "meal_items"."confidence" <= 1),
	CONSTRAINT "chk_quantity" CHECK ("meal_items"."quantity" > 0),
	CONSTRAINT "chk_nonneg_kcal" CHECK ("meal_items"."kcal" is null or "meal_items"."kcal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"user_id" uuid NOT NULL,
	"meal_type" "meal_type" NOT NULL,
	"status" "meal_status" DEFAULT 'draft' NOT NULL,
	"raw_input" text,
	"image_key" text,
	"total_kcal" numeric(8, 2),
	"total_protein_g" numeric(8, 2),
	"total_carbs_g" numeric(8, 2),
	"total_fat_g" numeric(8, 2),
	"total_fiber_g" numeric(8, 2),
	"nutrition_source" "nutrition_source",
	"confidence" numeric(4, 3),
	"user_confirmed" boolean DEFAULT false NOT NULL,
	"user_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meals_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "chk_meal_event" CHECK (("meals"."status" = 'confirmed') = ("meals"."event_id" is not null)),
	CONSTRAINT "chk_meal_confidence" CHECK ("meals"."confidence" is null or ("meals"."confidence" >= 0 and "meals"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "workout_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sets" integer,
	"reps" integer,
	"weight_kg" numeric(6, 2),
	"duration_sec" integer,
	"distance_km" numeric(7, 3),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"workout_type" "workout_type" NOT NULL,
	"status" "workout_status" NOT NULL,
	"skip_reason" "skip_reason",
	"skip_note" text,
	"duration_min" integer,
	"perceived_effort" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workout_sessions_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "chk_skip_reason" CHECK (("workout_sessions"."status" = 'skipped') = ("workout_sessions"."skip_reason" is not null)),
	CONSTRAINT "chk_perceived_effort" CHECK ("workout_sessions"."perceived_effort" is null or ("workout_sessions"."perceived_effort" between 1 and 5))
);
--> statement-breakpoint
CREATE TABLE "habit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"habit_id" uuid NOT NULL,
	"event_id" uuid,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"status" "habit_log_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "habits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"cadence" "habit_cadence" DEFAULT 'daily' NOT NULL,
	"schedule" jsonb,
	"icon" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"events_logged" integer DEFAULT 0 NOT NULL,
	"meals_logged" integer DEFAULT 0 NOT NULL,
	"vegetable_servings" integer DEFAULT 0 NOT NULL,
	"protein_servings" integer DEFAULT 0 NOT NULL,
	"distinct_foods" integer DEFAULT 0 NOT NULL,
	"water_ml" numeric(8, 1) DEFAULT '0' NOT NULL,
	"sleep_minutes" integer,
	"first_meal_time" time,
	"last_meal_time" time,
	"bedtime" time,
	"plan_adherence_pct" numeric(5, 2),
	"total_kcal" numeric(8, 2),
	"mood" "mood",
	"metrics" jsonb,
	"narrative" text,
	"ai_run_id" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_summary_adherence" CHECK ("daily_summaries"."plan_adherence_pct" is null or ("daily_summaries"."plan_adherence_pct" between 0 and 100)),
	CONSTRAINT "chk_summary_counts" CHECK ("daily_summaries"."events_logged" >= 0 and "daily_summaries"."meals_logged" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_events" ADD CONSTRAINT "daily_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plans" ADD CONSTRAINT "daily_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_id_daily_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."daily_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_linked_event_id_daily_events_id_fk" FOREIGN KEY ("linked_event_id") REFERENCES "public"."daily_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_event_id_daily_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."daily_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_portions" ADD CONSTRAINT "food_portions_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_event_id_daily_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."daily_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_session_id_workout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_event_id_daily_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."daily_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_event_id_daily_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."daily_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_users_active" ON "users" USING btree ("id") WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_events_user_date" ON "daily_events" USING btree ("user_id","local_date" DESC NULLS LAST) WHERE "daily_events"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_events_user_type_date" ON "daily_events" USING btree ("user_id","type","local_date" DESC NULLS LAST) WHERE "daily_events"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_events_occurred" ON "daily_events" USING btree ("user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plans_user_date" ON "daily_plans" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "idx_plan_items_plan" ON "plan_items" USING btree ("plan_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plan_items_link" ON "plan_items" USING btree ("linked_event_id") WHERE "plan_items"."linked_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_checkins_user_date" ON "checkins" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "idx_food_portions_food" ON "food_portions" USING btree ("food_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_foods_provider_ext" ON "foods" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_foods_barcode" ON "foods" USING btree ("barcode") WHERE "foods"."barcode" is not null;--> statement-breakpoint
CREATE INDEX "idx_foods_search" ON "foods" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "idx_foods_name_trgm" ON "foods" USING gin ("canonical_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_meal_items_meal" ON "meal_items" USING btree ("meal_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_meals_user_created" ON "meals" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "meals"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_meals_draft" ON "meals" USING btree ("user_id","status") WHERE "meals"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "idx_workout_exercises_session" ON "workout_exercises" USING btree ("session_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_workouts_user" ON "workout_sessions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_habit_log_day" ON "habit_logs" USING btree ("habit_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_habits_user_key" ON "habits" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_daily_sum" ON "daily_summaries" USING btree ("user_id","local_date");