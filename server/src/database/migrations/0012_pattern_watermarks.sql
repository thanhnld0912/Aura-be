CREATE TABLE "pattern_watermarks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"evaluated_through" date NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pattern_watermarks" ADD CONSTRAINT "pattern_watermarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;