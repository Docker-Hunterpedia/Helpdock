CREATE TYPE "public"."telegram_delivery_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "telegram_bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"department_id" uuid NOT NULL,
	"token" text NOT NULL,
	"token_updated_at" timestamp with time zone NOT NULL,
	"token_updated_by" uuid,
	"webhook_secret" text NOT NULL,
	"welcome_en" text,
	"welcome_ar" text,
	"language_pick" boolean DEFAULT true NOT NULL,
	"webhook_url" text,
	"webhook_set_at" timestamp with time zone,
	"poll_offset" bigint,
	"last_update_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"ticket_id" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"ticket_message_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"status" "telegram_delivery_status" DEFAULT 'queued' NOT NULL,
	"parts_sent" integer DEFAULT 0 NOT NULL,
	"sent_message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_token_updated_by_users_id_fk" FOREIGN KEY ("token_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_bot_id_telegram_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_ticket_message_id_ticket_messages_id_fk" FOREIGN KEY ("ticket_message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_bot_id_telegram_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bots_telegram_id_key" ON "telegram_bots" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX "telegram_bots_brand_idx" ON "telegram_bots" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_chats_bot_chat_key" ON "telegram_chats" USING btree ("bot_id","chat_id");--> statement-breakpoint
CREATE INDEX "telegram_chats_brand_contact_idx" ON "telegram_chats" USING btree ("brand_id","contact_id");--> statement-breakpoint
CREATE INDEX "telegram_chats_ticket_idx" ON "telegram_chats" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_deliveries_message_key" ON "telegram_deliveries" USING btree ("ticket_message_id");--> statement-breakpoint
CREATE INDEX "telegram_deliveries_ticket_idx" ON "telegram_deliveries" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "telegram_deliveries_brand_status_idx" ON "telegram_deliveries" USING btree ("brand_id","status");--> statement-breakpoint
-- M6-02. A reply's delivery is a child of its ticket: on the way in the shared
-- trigger copies the parent's department and refuses a ticket the transaction
-- cannot see.
CREATE TRIGGER telegram_deliveries_department
BEFORE INSERT ON public.telegram_deliveries
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

-- On a move the delivery follows the ticket. A trigger of its own rather than
-- another line in `helpdock_ticket_department_moved`, which every milestone
-- that adds a child replaces whole: two milestones replacing it at once would
-- each drop the other's line.
CREATE FUNCTION public.helpdock_telegram_deliveries_follow_ticket()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.telegram_deliveries
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tickets_telegram_deliveries_follow
AFTER UPDATE OF department_id ON public.tickets
FOR EACH ROW
WHEN (OLD.department_id IS DISTINCT FROM NEW.department_id)
EXECUTE FUNCTION public.helpdock_telegram_deliveries_follow_ticket();
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "telegram_bots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "telegram_bots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "telegram_bots_tenant_select" ON "telegram_bots" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "telegram_bots_tenant_insert" ON "telegram_bots" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "telegram_bots_tenant_update" ON "telegram_bots" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "telegram_bots_tenant_delete" ON "telegram_bots" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "telegram_chats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "telegram_chats" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "telegram_chats_tenant_select" ON "telegram_chats" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "telegram_chats_tenant_insert" ON "telegram_chats" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "telegram_chats_tenant_update" ON "telegram_chats" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "telegram_chats_tenant_delete" ON "telegram_chats" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "telegram_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "telegram_deliveries_tenant_select" ON "telegram_deliveries" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "telegram_deliveries_tenant_insert" ON "telegram_deliveries" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "telegram_deliveries_tenant_update" ON "telegram_deliveries" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "telegram_deliveries_tenant_delete" ON "telegram_deliveries" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
