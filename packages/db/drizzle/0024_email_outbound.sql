-- M2-05 and M2-06: outbound email. `email_outbound_settings` is a brand's SMTP
-- server, senders and auto-replies; `email_deliveries` is one outbound email,
-- the row the `email.send` job moves along and the Failed sends panel reads;
-- the two `users` columns are an agent's signature in each language.

CREATE TYPE "public"."email_delivery_kind" AS ENUM('reply', 'acknowledgment', 'out_of_hours');--> statement-breakpoint
CREATE TYPE "public"."email_delivery_status" AS ENUM('queued', 'sent', 'failed', 'discarded');--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"ticket_message_id" uuid,
	"kind" "email_delivery_kind" NOT NULL,
	"from_name" text NOT NULL,
	"from_address" text NOT NULL,
	"reply_to" text,
	"to_name" text,
	"to_address" text NOT NULL,
	"cc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"locale" "locale" NOT NULL,
	"message_id" text NOT NULL,
	"status" "email_delivery_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbound_settings" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_tls" text,
	"smtp_user" text,
	"smtp_password" text,
	"smtp_updated_at" timestamp with time zone,
	"smtp_updated_by" uuid,
	"default_from_name" text,
	"default_from_address" text,
	"department_senders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acknowledgment_enabled" boolean DEFAULT false NOT NULL,
	"out_of_hours_enabled" boolean DEFAULT false NOT NULL,
	"auto_reply_templates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_reply_hourly_cap" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbound_settings_cap_range" CHECK ("email_outbound_settings"."auto_reply_hourly_cap" BETWEEN 1 AND 50),
	CONSTRAINT "email_outbound_settings_port_range" CHECK ("email_outbound_settings"."smtp_port" IS NULL OR "email_outbound_settings"."smtp_port" BETWEEN 1 AND 65535)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signature_en" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signature_ar" text;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_ticket_message_id_ticket_messages_id_fk" FOREIGN KEY ("ticket_message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_settings" ADD CONSTRAINT "email_outbound_settings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_settings" ADD CONSTRAINT "email_outbound_settings_smtp_updated_by_users_id_fk" FOREIGN KEY ("smtp_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_message_key" ON "email_deliveries" USING btree ("ticket_message_id") WHERE "email_deliveries"."ticket_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_auto_reply_key" ON "email_deliveries" USING btree ("ticket_id","kind") WHERE "email_deliveries"."kind" <> 'reply';--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_brand_message_id_key" ON "email_deliveries" USING btree ("brand_id","message_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_brand_status_idx" ON "email_deliveries" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "email_deliveries_brand_recipient_idx" ON "email_deliveries" USING btree ("brand_id","to_address","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_brand_department_idx" ON "email_deliveries" USING btree ("brand_id","department_id");--> statement-breakpoint
-- M2-05. An outbound email is a child of its ticket: on the way in the shared
-- trigger copies the parent's department and refuses a ticket the transaction
-- cannot see, and on a move the email follows the ticket.
CREATE TRIGGER email_deliveries_department
BEFORE INSERT ON public.email_deliveries
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

-- The replacement carries every child `0023` moved; add to this list, never
-- replace it with a shorter one.
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
ALTER TABLE "email_outbound_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "email_outbound_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "email_outbound_settings_tenant_select" ON "email_outbound_settings" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "email_outbound_settings_tenant_insert" ON "email_outbound_settings" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "email_outbound_settings_tenant_update" ON "email_outbound_settings" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "email_outbound_settings_tenant_delete" ON "email_outbound_settings" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "email_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "email_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "email_deliveries_tenant_select" ON "email_deliveries" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "email_deliveries_tenant_insert" ON "email_deliveries" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "email_deliveries_tenant_update" ON "email_deliveries" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "email_deliveries_tenant_delete" ON "email_deliveries" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
