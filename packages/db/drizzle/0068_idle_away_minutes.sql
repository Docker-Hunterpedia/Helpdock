ALTER TABLE "departments" ADD COLUMN "idle_away_minutes" integer;--> statement-breakpoint
-- Owner decision 2026-10-21: departments that already exist get the closest
-- limit to 1.0's five-minute away timer the 10-minute minimum allows; the
-- column stays NULL for new rows.
UPDATE "departments" SET "idle_away_minutes" = 10 WHERE "idle_away_minutes" IS NULL;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_idle_away_minutes_range" CHECK ("departments"."idle_away_minutes" IS NULL OR "departments"."idle_away_minutes" BETWEEN 10 AND 240);