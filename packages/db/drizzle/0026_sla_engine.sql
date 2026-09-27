CREATE TYPE "public"."sla_breach_cause" AS ENUM('timer', 'change');--> statement-breakpoint
CREATE TYPE "public"."sla_clock_kind" AS ENUM('first_response', 'next_response', 'resolution');--> statement-breakpoint
CREATE TYPE "public"."sla_stop_reason" AS ENUM('merged', 'no_policy', 'closed', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."sla_time_mode" AS ENUM('business', 'calendar');--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"department_id" uuid,
	"timezone" text,
	"weekly" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_hours_brand_department_key" UNIQUE NULLS NOT DISTINCT("brand_id","department_id")
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"department_id" uuid,
	"name" varchar(120) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_ends_after_start" CHECK ("holidays"."ends_on" >= "holidays"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb NOT NULL,
	"time_mode" "sla_time_mode" DEFAULT 'business' NOT NULL,
	"targets" jsonb NOT NULL,
	"escalation" jsonb NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_sla_clocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"kind" "sla_clock_kind" NOT NULL,
	"cycle" integer DEFAULT 0 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"policy_id" uuid,
	"target_minutes" integer NOT NULL,
	"time_mode" "sla_time_mode" NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"elapsed_ms" bigint DEFAULT 0 NOT NULL,
	"checkpoint_at" timestamp (3) with time zone NOT NULL,
	"paused_at" timestamp (3) with time zone,
	"paused_total_ms" bigint DEFAULT 0 NOT NULL,
	"due_at" timestamp (3) with time zone,
	"satisfied_at" timestamp (3) with time zone,
	"breached_at" timestamp (3) with time zone,
	"breach_cause" "sla_breach_cause",
	"stopped_at" timestamp (3) with time zone,
	"stop_reason" "sla_stop_reason",
	"fired_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "sla_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "sla_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_clocks" ADD CONSTRAINT "ticket_sla_clocks_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_clocks" ADD CONSTRAINT "ticket_sla_clocks_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_clocks" ADD CONSTRAINT "ticket_sla_clocks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_clocks" ADD CONSTRAINT "ticket_sla_clocks_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holidays_brand_starts_idx" ON "holidays" USING btree ("brand_id","starts_on");--> statement-breakpoint
CREATE INDEX "holidays_brand_department_idx" ON "holidays" USING btree ("brand_id","department_id") WHERE "holidays"."department_id" is not null;--> statement-breakpoint
CREATE INDEX "sla_policies_brand_position_idx" ON "sla_policies" USING btree ("brand_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_sla_clocks_ticket_kind_cycle_key" ON "ticket_sla_clocks" USING btree ("ticket_id","kind","cycle");--> statement-breakpoint
CREATE INDEX "ticket_sla_clocks_brand_running_idx" ON "ticket_sla_clocks" USING btree ("brand_id","ticket_id") WHERE "ticket_sla_clocks"."is_current" AND "ticket_sla_clocks"."satisfied_at" IS NULL AND "ticket_sla_clocks"."stopped_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ticket_sla_clocks_brand_department_idx" ON "ticket_sla_clocks" USING btree ("brand_id","department_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sla_policy_id_sla_policies_id_fk" FOREIGN KEY ("sla_policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- M3-02. A ticket's clocks are a child of the ticket and a department-scoped
-- table of DOMAIN-RULES §1.3, so they join the triggers `0008` wrote, as
-- `ticket_time_entries` did in `0018`: the department is copied from the parent
-- on the way in (and the insert is refused when the parent is invisible), and
-- it moves with the ticket.
CREATE TRIGGER ticket_sla_clocks_department
BEFORE INSERT ON public.ticket_sla_clocks
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.helpdock_ticket_department_moved()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.ticket_messages
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_activity
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.attachments
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_tags
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_participants
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_time_entries
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.csat_responses
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_search_tokens
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  -- M2-05.
  UPDATE public.email_deliveries
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  -- M3-02.
  UPDATE public.ticket_sla_clocks
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "business_hours" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "business_hours" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "business_hours_tenant_select" ON "business_hours" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "business_hours_tenant_insert" ON "business_hours" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "business_hours_tenant_update" ON "business_hours" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "business_hours_tenant_delete" ON "business_hours" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "holidays" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "holidays" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "holidays_tenant_select" ON "holidays" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "holidays_tenant_insert" ON "holidays" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "holidays_tenant_update" ON "holidays" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "holidays_tenant_delete" ON "holidays" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "sla_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sla_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sla_policies_tenant_select" ON "sla_policies" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "sla_policies_tenant_insert" ON "sla_policies" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "sla_policies_tenant_update" ON "sla_policies" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "sla_policies_tenant_delete" ON "sla_policies" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "ticket_sla_clocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ticket_sla_clocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_sla_clocks_tenant_select" ON "ticket_sla_clocks" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_sla_clocks_tenant_insert" ON "ticket_sla_clocks" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_sla_clocks_tenant_update" ON "ticket_sla_clocks" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_sla_clocks_tenant_delete" ON "ticket_sla_clocks" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
