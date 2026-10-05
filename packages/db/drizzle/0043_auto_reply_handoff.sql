ALTER TABLE "tickets" ADD COLUMN "ai_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ai_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ai_pause_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ai_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ai_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ai_handed_off_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tickets_brand_ai_eligible_idx" ON "tickets" USING btree ("brand_id","ai_eligible_at") WHERE "tickets"."ai_eligible_at" is not null;