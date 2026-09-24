-- M1-09 Merge and split (DOMAIN-RULES §2.4): the columns an unmerge restores
-- from, the provenance of a split's copies, the key code finds the Merged
-- status by, and the trigger that keeps a merged ticket in its primary's
-- department.
--
-- `attachments.s3_key` stops being unique across every row and becomes unique
-- among originals: a split's copy of an attachment points at the same object
-- rather than duplicating its bytes.

ALTER TABLE "attachments" DROP CONSTRAINT "attachments_s3_key_unique";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "copied_from_attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "copied_from_message_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_statuses" ADD COLUMN "system_key" varchar(40);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "merged_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "merged_by_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pre_merge_status_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pre_merge_department_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "merge_message_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "merged_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_copied_from_message_id_ticket_messages_id_fk" FOREIGN KEY ("copied_from_message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_merged_by_id_users_id_fk" FOREIGN KEY ("merged_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_pre_merge_status_id_ticket_statuses_id_fk" FOREIGN KEY ("pre_merge_status_id") REFERENCES "public"."ticket_statuses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_pre_merge_department_id_departments_id_fk" FOREIGN KEY ("pre_merge_department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_s3_key_original_key" ON "attachments" USING btree ("s3_key") WHERE "attachments"."copied_from_attachment_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_statuses_brand_system_key" ON "ticket_statuses" USING btree ("brand_id","system_key") WHERE "ticket_statuses"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "tickets_merged_into_idx" ON "tickets" USING btree ("merged_into_id") WHERE "tickets"."merged_into_id" is not null;--> statement-breakpoint
CREATE INDEX "tickets_split_from_idx" ON "tickets" USING btree ("split_from_id") WHERE "tickets"."split_from_id" is not null;--> statement-breakpoint

-- The seeded rows of every existing brand get their key. They are matched on
-- the name they were seeded with: `is_system` rows may be renamed, but not
-- before this release, which is the first to let anything depend on the key.
UPDATE "ticket_statuses"
SET "system_key" = CASE "name"
  WHEN 'Open' THEN 'open'
  WHEN 'Awaiting customer' THEN 'awaiting_customer'
  WHEN 'Escalated' THEN 'escalated'
  WHEN 'Closed' THEN 'closed'
  WHEN 'Spam' THEN 'spam'
  WHEN 'Merged' THEN 'merged'
END
WHERE "is_system" AND "system_key" IS NULL;--> statement-breakpoint

-- DOMAIN-RULES §2.4: "attachments remain on their original messages; access
-- follows the primary ticket after merge". A merge moves the secondary into the
-- primary's department, which takes its thread, activity, tags and attachments
-- with it through `helpdock_ticket_department_moved`; this keeps it there
-- afterwards. When a primary moves, every ticket merged into it follows, and
-- the UPDATE fires this trigger again on each of them, so a chain of merges
-- moves as one.
--
-- A trigger of its own rather than one more statement in
-- `helpdock_ticket_department_moved`: that function is the list of a ticket's
-- *children*, and a merged ticket is a ticket.
--
-- Invoker rights, like its sibling. A secondary is always in its primary's
-- department, so the rows it moves are rows the actor could already see, and
-- the new department is the one the actor's own UPDATE was allowed into.
CREATE FUNCTION public.helpdock_ticket_merged_follow_primary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.tickets
  SET department_id = NEW.department_id
  WHERE merged_into_id = NEW.id
    AND department_id IS DISTINCT FROM NEW.department_id;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tickets_merged_follow_primary
AFTER UPDATE OF department_id ON public.tickets
FOR EACH ROW
WHEN (OLD.department_id IS DISTINCT FROM NEW.department_id)
EXECUTE FUNCTION public.helpdock_ticket_merged_follow_primary();
