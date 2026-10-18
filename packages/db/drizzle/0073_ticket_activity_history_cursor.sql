DROP INDEX "ticket_activity_ticket_created_idx";--> statement-breakpoint
CREATE INDEX "ticket_activity_ticket_created_idx" ON "ticket_activity" USING btree ("ticket_id","created_at","id");