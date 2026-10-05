ALTER TABLE "report_daily" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "report_daily" ADD COLUMN "rollup_version" smallint DEFAULT 1 NOT NULL;