ALTER TABLE "ai_settings" ADD COLUMN "system_prompt_ar" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "modes" jsonb;