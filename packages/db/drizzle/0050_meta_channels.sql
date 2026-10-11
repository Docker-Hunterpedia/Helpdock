-- M10-01: the Meta channels (ADR 0025). `meta_accounts` (brand) is a WhatsApp
-- number, a Facebook Page or an Instagram account with its encrypted token;
-- `meta_conversations` (brand) maps a customer to their contact and ticket and
-- anchors the reply window; `meta_deliveries` (department) is one agent reply
-- on its way. The channel, identity, duplicate-reason and block-list enums gain
-- `whatsapp`, `messenger` and `instagram`. Nothing here uses a new value, so
-- running inside the migration's transaction is safe.
CREATE TYPE "public"."meta_account_status" AS ENUM('connected', 'token_expired', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."meta_delivery_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'refused');--> statement-breakpoint
CREATE TYPE "public"."meta_platform" AS ENUM('whatsapp', 'messenger', 'instagram');--> statement-breakpoint
CREATE TYPE "public"."meta_token_kind" AS ENUM('system_user', 'page', 'instagram_user');--> statement-breakpoint
ALTER TYPE "public"."blocked_sender_kind" ADD VALUE 'whatsapp';--> statement-breakpoint
ALTER TYPE "public"."blocked_sender_kind" ADD VALUE 'messenger';--> statement-breakpoint
ALTER TYPE "public"."blocked_sender_kind" ADD VALUE 'instagram';--> statement-breakpoint
ALTER TYPE "public"."contact_duplicate_reason" ADD VALUE 'whatsapp';--> statement-breakpoint
ALTER TYPE "public"."contact_duplicate_reason" ADD VALUE 'messenger';--> statement-breakpoint
ALTER TYPE "public"."contact_duplicate_reason" ADD VALUE 'instagram';--> statement-breakpoint
ALTER TYPE "public"."contact_identity_kind" ADD VALUE 'whatsapp';--> statement-breakpoint
ALTER TYPE "public"."contact_identity_kind" ADD VALUE 'messenger';--> statement-breakpoint
ALTER TYPE "public"."contact_identity_kind" ADD VALUE 'instagram';--> statement-breakpoint
ALTER TYPE "public"."ticket_channel" ADD VALUE 'whatsapp';--> statement-breakpoint
ALTER TYPE "public"."ticket_channel" ADD VALUE 'messenger';--> statement-breakpoint
ALTER TYPE "public"."ticket_channel" ADD VALUE 'instagram';--> statement-breakpoint
CREATE TABLE "meta_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"platform" "meta_platform" NOT NULL,
	"department_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"waba_id" text,
	"display_phone" text,
	"username" text,
	"display_name" text NOT NULL,
	"access_token" text NOT NULL,
	"token_kind" "meta_token_kind" NOT NULL,
	"token_expires_at" timestamp with time zone,
	"token_refreshed_at" timestamp with time zone,
	"token_updated_at" timestamp with time zone NOT NULL,
	"token_updated_by" uuid,
	"human_agent_enabled" boolean DEFAULT false NOT NULL,
	"subscribed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"subscribed_at" timestamp with time zone,
	"subscription_checked_at" timestamp with time zone,
	"status" "meta_account_status" DEFAULT 'connected' NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"ticket_id" uuid,
	"wa_id" text,
	"profile_name" text,
	"username" text,
	"last_inbound_at" timestamp with time zone,
	"last_inbound_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"ticket_message_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"status" "meta_delivery_status" DEFAULT 'queued' NOT NULL,
	"parts_sent" integer DEFAULT 0 NOT NULL,
	"platform_message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"error_code" text,
	"tag" text,
	"template_name" text,
	"pricing_category" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_accounts" ADD CONSTRAINT "meta_accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_accounts" ADD CONSTRAINT "meta_accounts_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_accounts" ADD CONSTRAINT "meta_accounts_token_updated_by_users_id_fk" FOREIGN KEY ("token_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_conversations" ADD CONSTRAINT "meta_conversations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_conversations" ADD CONSTRAINT "meta_conversations_account_id_meta_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."meta_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_conversations" ADD CONSTRAINT "meta_conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_conversations" ADD CONSTRAINT "meta_conversations_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_deliveries" ADD CONSTRAINT "meta_deliveries_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_deliveries" ADD CONSTRAINT "meta_deliveries_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_deliveries" ADD CONSTRAINT "meta_deliveries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_deliveries" ADD CONSTRAINT "meta_deliveries_ticket_message_id_ticket_messages_id_fk" FOREIGN KEY ("ticket_message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_deliveries" ADD CONSTRAINT "meta_deliveries_account_id_meta_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."meta_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_deliveries" ADD CONSTRAINT "meta_deliveries_conversation_id_meta_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."meta_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_accounts_platform_external_key" ON "meta_accounts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "meta_accounts_brand_idx" ON "meta_accounts" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_conversations_account_customer_key" ON "meta_conversations" USING btree ("account_id","customer_id");--> statement-breakpoint
CREATE INDEX "meta_conversations_brand_contact_idx" ON "meta_conversations" USING btree ("brand_id","contact_id");--> statement-breakpoint
CREATE INDEX "meta_conversations_ticket_idx" ON "meta_conversations" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_deliveries_message_key" ON "meta_deliveries" USING btree ("ticket_message_id");--> statement-breakpoint
CREATE INDEX "meta_deliveries_ticket_idx" ON "meta_deliveries" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "meta_deliveries_brand_status_idx" ON "meta_deliveries" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "meta_deliveries_conversation_sent_idx" ON "meta_deliveries" USING btree ("conversation_id","sent_at");--> statement-breakpoint

-- M10-01. A reply's delivery is a child of its ticket: on the way in the shared
-- trigger copies the parent's department and refuses a ticket the transaction
-- cannot see.
CREATE TRIGGER meta_deliveries_department
BEFORE INSERT ON public.meta_deliveries
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

-- On a move the delivery follows the ticket. A function of its own for the
-- reason 0036 gives: `helpdock_ticket_department_moved` is replaced whole by
-- every milestone that adds a child, so two milestones replacing it at once
-- would each drop the other's line.
CREATE FUNCTION public.helpdock_meta_deliveries_follow_ticket()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.meta_deliveries
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tickets_meta_deliveries_follow
AFTER UPDATE OF department_id ON public.tickets
FOR EACH ROW
WHEN (OLD.department_id IS DISTINCT FROM NEW.department_id)
EXECUTE FUNCTION public.helpdock_meta_deliveries_follow_ticket();
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "meta_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "meta_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "meta_accounts_tenant_select" ON "meta_accounts" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "meta_accounts_tenant_insert" ON "meta_accounts" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "meta_accounts_tenant_update" ON "meta_accounts" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "meta_accounts_tenant_delete" ON "meta_accounts" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "meta_conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "meta_conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "meta_conversations_tenant_select" ON "meta_conversations" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "meta_conversations_tenant_insert" ON "meta_conversations" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "meta_conversations_tenant_update" ON "meta_conversations" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "meta_conversations_tenant_delete" ON "meta_conversations" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "meta_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "meta_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "meta_deliveries_tenant_select" ON "meta_deliveries" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "meta_deliveries_tenant_insert" ON "meta_deliveries" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "meta_deliveries_tenant_update" ON "meta_deliveries" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "meta_deliveries_tenant_delete" ON "meta_deliveries" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
