CREATE TYPE "public"."ai_provider" AS ENUM('anthropic', 'google');--> statement-breakpoint
CREATE TYPE "public"."ai_purpose" AS ENUM('meal_parse', 'meal_vision', 'daily', 'weekly', 'pattern', 'chat', 'plan');--> statement-breakpoint
CREATE TYPE "public"."ai_status" AS ENUM('ok', 'schema_error', 'provider_error', 'timeout', 'refused', 'blocked');--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "ai_purpose" NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"status" "ai_status" NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_input_tokens" integer,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"request_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_runs_user_time" ON "ai_runs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ai_runs_purpose" ON "ai_runs" USING btree ("purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "daily_plans" ADD CONSTRAINT "daily_plans_generated_by_ai_run_ai_runs_id_fk" FOREIGN KEY ("generated_by_ai_run") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;