ALTER TABLE "tickets" ADD COLUMN "reply_mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "arrival_mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "arrival_to_address" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_reply_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("reply_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_arrival_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("arrival_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_brand_arrival_mailbox_idx" ON "tickets" USING btree ("brand_id","arrival_mailbox_id") WHERE "tickets"."arrival_mailbox_id" is not null;--> statement-breakpoint
CREATE INDEX "tickets_brand_arrival_to_idx" ON "tickets" USING btree ("brand_id",lower("arrival_to_address")) WHERE "tickets"."arrival_to_address" is not null;--> statement-breakpoint

-- M14-26. Backfill the arrival facts from the arrival record M14-08 wrote on the
-- row that filed each ticket (the earliest of created, continued, imported that
-- carries one). Both tables are FORCEd, so the owner would see nothing without
-- lifting it for the statement, as 0064 does for views.
ALTER TABLE "tickets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_activity" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mailboxes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "tickets" AS t
SET "arrival_mailbox_id" = m."id",
    "arrival_to_address" = lower(a."to" -> 'arrival' ->> 'address')
FROM (
  SELECT DISTINCT ON ("ticket_id") "ticket_id", "to"
  FROM "ticket_activity"
  WHERE "action" IN ('ticket.created', 'ticket.continued', 'ticket.imported')
    AND "to" ? 'arrival'
    AND "to" -> 'arrival' ->> 'entry' = 'mailbox'
  ORDER BY "ticket_id", "created_at", "id"
) AS a
JOIN "mailboxes" AS m ON m."id"::text = a."to" -> 'arrival' ->> 'entryId'
WHERE t."id" = a."ticket_id" AND m."brand_id" = t."brand_id";--> statement-breakpoint
ALTER TABLE "mailboxes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;
