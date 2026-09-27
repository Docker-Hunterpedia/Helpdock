-- M3-03, M3-04: workflow rules and their execution log, and the one column
-- time-based rules measure from.
--
-- `workflow_rules` is brand-scoped configuration. `workflow_runs` is a child
-- of a ticket and department-scoped like the others (DOMAIN-RULES §1.3); the
-- engine writes the department the ticket is in when the run happens.
--
-- `tickets.status_changed_at` is "time in status": set by a trigger on every
-- change of `status_id`, so no code path that moves a status can forget it.
-- Existing tickets are backfilled from their newest status change in the
-- activity log, or their creation. Row-level security is forced on both tables,
-- so force is lifted for the backfill inside the migration's transaction and
-- put back at once, as `0023` does.
CREATE TYPE "public"."workflow_rule_kind" AS ENUM('event', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."workflow_run_result" AS ENUM('applied', 'skipped', 'stopped', 'failed');--> statement-breakpoint
CREATE TABLE "workflow_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(300),
	"kind" "workflow_rule_kind" NOT NULL,
	"trigger" varchar(40),
	"interval_minutes" integer,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"position" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_scheduled_run_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_name" varchar(120) NOT NULL,
	"ticket_id" uuid NOT NULL,
	"trigger" varchar(40) NOT NULL,
	"result" "workflow_run_result" NOT NULL,
	"stop_reason" varchar(10),
	"depth" integer NOT NULL,
	"chain" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"match_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_rules" ADD CONSTRAINT "workflow_rules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_rule_id_workflow_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."workflow_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_rules_brand_kind_position_idx" ON "workflow_rules" USING btree ("brand_id","kind","position");--> statement-breakpoint
CREATE INDEX "workflow_runs_brand_created_idx" ON "workflow_runs" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_rule_created_idx" ON "workflow_runs" USING btree ("rule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_rule_ticket_match_key" ON "workflow_runs" USING btree ("rule_id","ticket_id","match_key") WHERE "workflow_runs"."match_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tickets_brand_status_changed_idx" ON "tickets" USING btree ("brand_id","status_id","status_changed_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.helpdock_ticket_status_changed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tickets_status_changed_at
  BEFORE UPDATE OF status_id ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.helpdock_ticket_status_changed_at();
--> statement-breakpoint
ALTER TABLE "tickets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_activity" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.tickets AS t
SET status_changed_at = coalesce(
  (SELECT max(a.created_at) FROM public.ticket_activity AS a
    WHERE a.ticket_id = t.id AND a.action = 'ticket.status.changed'),
  t.created_at
);--> statement-breakpoint
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_activity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "workflow_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_rules_tenant_select" ON "workflow_rules" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "workflow_rules_tenant_insert" ON "workflow_rules" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "workflow_rules_tenant_update" ON "workflow_rules" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "workflow_rules_tenant_delete" ON "workflow_rules" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_runs_tenant_select" ON "workflow_runs" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "workflow_runs_tenant_insert" ON "workflow_runs" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "workflow_runs_tenant_update" ON "workflow_runs" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "workflow_runs_tenant_delete" ON "workflow_runs" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
