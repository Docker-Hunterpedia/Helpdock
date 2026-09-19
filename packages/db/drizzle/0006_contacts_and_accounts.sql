CREATE TYPE "public"."contact_duplicate_status" AS ENUM('open', 'dismissed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."contact_identity_kind" AS ENUM('email', 'phone', 'telegram', 'visitor', 'external');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_brand_domain_key" UNIQUE("brand_id","domain")
);
--> statement-breakpoint
CREATE TABLE "contact_duplicate_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"other_contact_id" uuid NOT NULL,
	"reason" "contact_identity_kind" NOT NULL,
	"status" "contact_duplicate_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_duplicate_suggestions_pair_key" UNIQUE("brand_id","contact_id","other_contact_id")
);
--> statement-breakpoint
CREATE TABLE "contact_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" "contact_identity_kind" NOT NULL,
	"value" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_identities_brand_kind_value_key" UNIQUE("brand_id","kind","value")
);
--> statement-breakpoint
CREATE TABLE "contact_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"locale" "locale",
	"timezone" text,
	"external_id" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anonymised_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_duplicate_suggestions" ADD CONSTRAINT "contact_duplicate_suggestions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_duplicate_suggestions" ADD CONSTRAINT "contact_duplicate_suggestions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_duplicate_suggestions" ADD CONSTRAINT "contact_duplicate_suggestions_other_contact_id_contacts_id_fk" FOREIGN KEY ("other_contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_identities_contact_idx" ON "contact_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_notes_contact_created_at_idx" ON "contact_notes" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "contacts_brand_updated_at_idx" ON "contacts" USING btree ("brand_id","updated_at");--> statement-breakpoint
CREATE INDEX "contacts_brand_account_idx" ON "contacts" USING btree ("brand_id","account_id");
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "accounts_tenant_select" ON "accounts" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "accounts_tenant_insert" ON "accounts" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "accounts_tenant_update" ON "accounts" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "accounts_tenant_delete" ON "accounts" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contacts_tenant_select" ON "contacts" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contacts_tenant_insert" ON "contacts" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contacts_tenant_update" ON "contacts" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contacts_tenant_delete" ON "contacts" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "contact_identities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contact_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contact_identities_tenant_select" ON "contact_identities" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_identities_tenant_insert" ON "contact_identities" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_identities_tenant_update" ON "contact_identities" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_identities_tenant_delete" ON "contact_identities" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "contact_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contact_notes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contact_notes_tenant_select" ON "contact_notes" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_notes_tenant_insert" ON "contact_notes" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_notes_tenant_update" ON "contact_notes" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_notes_tenant_delete" ON "contact_notes" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "contact_duplicate_suggestions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contact_duplicate_suggestions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contact_duplicate_suggestions_tenant_select" ON "contact_duplicate_suggestions" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_duplicate_suggestions_tenant_insert" ON "contact_duplicate_suggestions" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_duplicate_suggestions_tenant_update" ON "contact_duplicate_suggestions" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "contact_duplicate_suggestions_tenant_delete" ON "contact_duplicate_suggestions" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
