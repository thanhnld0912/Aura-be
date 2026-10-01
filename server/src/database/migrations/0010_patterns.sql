CREATE TYPE "public"."pattern_direction" AS ENUM('positive', 'negative', 'none');--> statement-breakpoint
CREATE TYPE "public"."pattern_kind" AS ENUM('correlation', 'trend', 'timing', 'frequency', 'streak');--> statement-breakpoint
CREATE TYPE "public"."pattern_status" AS ENUM('active', 'stale', 'dismissed');--> statement-breakpoint
CREATE TABLE "patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" "pattern_kind" NOT NULL,
	"subject_metric" text NOT NULL,
	"object_metric" text,
	"direction" "pattern_direction" NOT NULL,
	"strength" double precision NOT NULL,
	"p_value" double precision,
	"sample_size" integer NOT NULL,
	"coverage" double precision NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"window_days" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"detector_version" text NOT NULL,
	"status" "pattern_status" DEFAULT 'active' NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_pattern_strength" CHECK ("patterns"."strength" >= 0 and "patterns"."strength" <= 1),
	CONSTRAINT "chk_pattern_p_value" CHECK ("patterns"."p_value" is null or ("patterns"."p_value" >= 0 and "patterns"."p_value" <= 1)),
	CONSTRAINT "chk_pattern_coverage" CHECK ("patterns"."coverage" >= 0 and "patterns"."coverage" <= 1),
	CONSTRAINT "chk_pattern_sample" CHECK ("patterns"."sample_size" >= 1),
	CONSTRAINT "chk_pattern_window" CHECK ("patterns"."window_days" >= 1 and "patterns"."window_end" - "patterns"."window_start" + 1 = "patterns"."window_days"),
	CONSTRAINT "chk_pattern_inference" CHECK (("patterns"."p_value" is null) = ("patterns"."kind" in ('frequency', 'streak'))),
	CONSTRAINT "chk_pattern_object" CHECK ("patterns"."kind" not in ('correlation', 'timing') or "patterns"."object_metric" is not null),
	CONSTRAINT "chk_pattern_key_kind" CHECK (starts_with("patterns"."key", "patterns"."kind"::text || ':')),
	CONSTRAINT "chk_pattern_detected_order" CHECK ("patterns"."first_detected_at" <= "patterns"."last_detected_at")
);
--> statement-breakpoint
ALTER TABLE "patterns" ADD CONSTRAINT "patterns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_patterns_user_key" ON "patterns" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "idx_patterns_stale" ON "patterns" USING btree ("status_changed_at") WHERE "patterns"."status" = 'stale';