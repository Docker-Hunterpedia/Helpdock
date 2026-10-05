CREATE TYPE "public"."csat_answer_channel" AS ENUM('link', 'widget', 'telegram');--> statement-breakpoint
ALTER TYPE "public"."email_delivery_kind" ADD VALUE 'csat';--> statement-breakpoint
ALTER TABLE "csat_responses" ADD COLUMN "rated_via" "csat_answer_channel";--> statement-breakpoint
ALTER TABLE "csat_responses" ADD COLUMN "skipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "csat_response_id" uuid;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_csat_response_id_csat_responses_id_fk" FOREIGN KEY ("csat_response_id") REFERENCES "public"."csat_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_csat_key" ON "email_deliveries" USING btree ("csat_response_id") WHERE "email_deliveries"."csat_response_id" is not null;--> statement-breakpoint
-- Every answer before M8-06 came through the rating page.
UPDATE "csat_responses" SET "rated_via" = 'link' WHERE "rated_at" IS NOT NULL;
