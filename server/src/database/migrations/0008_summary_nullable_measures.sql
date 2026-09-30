ALTER TABLE "daily_summaries" ALTER COLUMN "vegetable_servings" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "daily_summaries" ALTER COLUMN "vegetable_servings" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_summaries" ALTER COLUMN "protein_servings" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "daily_summaries" ALTER COLUMN "protein_servings" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_summaries" ALTER COLUMN "distinct_foods" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "daily_summaries" ALTER COLUMN "distinct_foods" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_summaries" ALTER COLUMN "water_ml" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "daily_summaries" ALTER COLUMN "water_ml" DROP NOT NULL;