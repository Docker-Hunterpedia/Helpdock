ALTER TABLE "ticket_statuses" ADD COLUMN "excluded_from_reports" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "deleted_at" timestamp with time zone;