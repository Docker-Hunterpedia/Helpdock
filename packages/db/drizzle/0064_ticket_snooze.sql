ALTER TYPE "public"."notification_kind" ADD VALUE 'snooze_ended';--> statement-breakpoint
ALTER TYPE "public"."ticket_view_built_in" ADD VALUE 'snoozed';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "snoozed_until" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "snoozed_by" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "snooze_resume_status_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "snooze_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_snoozed_by_users_id_fk" FOREIGN KEY ("snoozed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_snooze_resume_status_id_ticket_statuses_id_fk" FOREIGN KEY ("snooze_resume_status_id") REFERENCES "public"."ticket_statuses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_brand_snoozed_until_idx" ON "tickets" USING btree ("brand_id","snoozed_until") WHERE "tickets"."snoozed_until" is not null;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_snooze_detail_requires_until" CHECK ("tickets"."snoozed_until" is not null or ("tickets"."snoozed_by" is null and "tickets"."snooze_resume_status_id" is null));--> statement-breakpoint

-- M14-02. A ticket is in Snoozed exactly when `snoozed_until` is set, whichever
-- code path wrote the row (a person, a rule, a macro, the SLA engine, a merge,
-- a channel inbound). This trigger is what makes that true:
--
-- - a change of status to anything but Snoozed clears the three snooze columns,
--   so "any other status change clears the snooze" has no writer to forget;
-- - every change of `snoozed_until` bumps `snooze_version`, which is what a
--   delayed `ticket.unsnooze` job is keyed on (`snooze.<ticket>.<version>`).
--
-- Invoker rights and an empty search path, like its siblings: it reads only
-- `ticket_statuses`, a brand-scoped table the writer can already see.
CREATE FUNCTION public.helpdock_ticket_snooze_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.snoozed_until IS NOT NULL
     AND NEW.status_id IS DISTINCT FROM OLD.status_id
     AND NOT EXISTS (
       SELECT 1 FROM public.ticket_statuses AS s
       WHERE s.id = NEW.status_id AND s.system_key = 'snoozed'
     )
  THEN
    NEW.snoozed_until := NULL;
    NEW.snoozed_by := NULL;
    NEW.snooze_resume_status_id := NULL;
  END IF;

  IF NEW.snoozed_until IS DISTINCT FROM OLD.snoozed_until THEN
    NEW.snooze_version := OLD.snooze_version + 1;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tickets_snooze_guard
BEFORE UPDATE OF status_id, snoozed_until ON public.tickets
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_snooze_guard();--> statement-breakpoint

-- Every existing brand gets the Snoozed status `seedBrandStatuses` now writes
-- for new ones. A brand that already made a status called "Snoozed" keeps it as
-- an ordinary status and gets the system one under a second name, which it may
-- rename. The tables are under FORCE ROW LEVEL SECURITY, lifted for these
-- statements inside the migration's transaction and put back after.
ALTER TABLE "ticket_statuses" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "ticket_statuses" (
  "id", "brand_id", "name", "name_ar", "system_state", "pauses_sla", "awaiting_customer",
  "is_default", "is_system", "excluded_from_reports", "system_key", "sort_order", "color"
)
SELECT
  gen_random_uuid(),
  b."id",
  CASE WHEN EXISTS (
    SELECT 1 FROM "ticket_statuses" AS s WHERE s."brand_id" = b."id" AND s."name" = 'Snoozed'
  ) THEN 'Snoozed (system)' ELSE 'Snoozed' END,
  'مؤجَّلة',
  'on_hold', true, false, false, true, false, 'snoozed', 25, 'warning'
FROM "brands" AS b
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "ticket_statuses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The Snoozed view takes the place under My open. It cannot be inserted here:
-- a value added to an enum cannot be used in the transaction that added it, so
-- the api writes it for existing brands at boot (`seedBrandViews`).
--
-- WARNING: drizzle applies every pending migration in ONE transaction, so on a
-- fresh install no later migration may use `'snoozed'::ticket_view_built_in`
-- (or `'snooze_ended'::notification_kind`) either: it would fail with "unsafe use
-- of new value of enum type". Write such rows from the api at boot instead.
ALTER TABLE "views" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "views" SET "sort_order" = 2 WHERE "built_in" = 'unassigned' AND "sort_order" = 1;--> statement-breakpoint
UPDATE "views" SET "sort_order" = 3 WHERE "built_in" = 'overdue' AND "sort_order" = 2;--> statement-breakpoint
UPDATE "views" SET "sort_order" = "sort_order" + 1 WHERE "built_in" = 'department_open';--> statement-breakpoint
ALTER TABLE "views" FORCE ROW LEVEL SECURITY;
