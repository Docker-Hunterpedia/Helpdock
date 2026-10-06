CREATE TYPE "public"."article_proposal_status" AS ENUM('waiting', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."transcript_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "article_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"section_id" uuid,
	"locale" "locale" NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"note" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_call_id" uuid,
	"status" "article_proposal_status" DEFAULT 'waiting' NOT NULL,
	"proposed_by" uuid,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"article_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ticket_field_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"tag_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"priority" "ticket_priority",
	"suggested_department_id" uuid,
	"source" text NOT NULL,
	"ai_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "transcript_status" "transcript_status";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "transcript_text" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "transcript_language" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "transcribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_section_id_hc_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."hc_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_proposals" ADD CONSTRAINT "article_proposals_article_id_hc_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."hc_articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_field_suggestions" ADD CONSTRAINT "ticket_field_suggestions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_field_suggestions" ADD CONSTRAINT "ticket_field_suggestions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_field_suggestions" ADD CONSTRAINT "ticket_field_suggestions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_field_suggestions" ADD CONSTRAINT "ticket_field_suggestions_suggested_department_id_departments_id_fk" FOREIGN KEY ("suggested_department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_field_suggestions" ADD CONSTRAINT "ticket_field_suggestions_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_proposals_brand_status_idx" ON "article_proposals" USING btree ("brand_id","status","proposed_at");--> statement-breakpoint
CREATE INDEX "article_proposals_ticket_idx" ON "article_proposals" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "article_proposals_brand_department_idx" ON "article_proposals" USING btree ("brand_id","department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_field_suggestions_ticket_key" ON "ticket_field_suggestions" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_field_suggestions_brand_department_idx" ON "ticket_field_suggestions" USING btree ("brand_id","department_id");
--> statement-breakpoint
-- M7-05, M7-07. Both quote a ticket, so both are its children: the shared
-- trigger copies the parent's department on the way in and refuses a ticket
-- the transaction cannot see.
CREATE TRIGGER article_proposals_department
BEFORE INSERT ON public.article_proposals
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

CREATE TRIGGER ticket_field_suggestions_department
BEFORE INSERT ON public.ticket_field_suggestions
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

-- On a move they follow the ticket, by a trigger of their own for the reason
-- `0036` gives: `helpdock_ticket_department_moved` is replaced whole by every
-- milestone that edits it.
CREATE FUNCTION public.helpdock_ai_assist_follow_ticket()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.article_proposals
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_field_suggestions
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tickets_ai_assist_follow
AFTER UPDATE OF department_id ON public.tickets
FOR EACH ROW
WHEN (OLD.department_id IS DISTINCT FROM NEW.department_id)
EXECUTE FUNCTION public.helpdock_ai_assist_follow_ticket();
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "article_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "article_proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "article_proposals_tenant_select" ON "article_proposals" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "article_proposals_tenant_insert" ON "article_proposals" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "article_proposals_tenant_update" ON "article_proposals" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "article_proposals_tenant_delete" ON "article_proposals" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
ALTER TABLE "ticket_field_suggestions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ticket_field_suggestions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_field_suggestions_tenant_select" ON "ticket_field_suggestions" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_field_suggestions_tenant_insert" ON "ticket_field_suggestions" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_field_suggestions_tenant_update" ON "ticket_field_suggestions" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_field_suggestions_tenant_delete" ON "ticket_field_suggestions" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
