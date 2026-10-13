CREATE TYPE "public"."attachment_origin" AS ENUM('upload', 'channel', 'import');--> statement-breakpoint
CREATE TYPE "public"."import_entity" AS ENUM('user', 'contact', 'organization', 'group', 'field', 'tag', 'ticket', 'message', 'attachment', 'csat', 'category', 'section', 'article');--> statement-breakpoint
CREATE TYPE "public"."import_log_level" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."import_mapping_kind" AS ENUM('status', 'priority', 'group', 'agent', 'field', 'tag', 'channel');--> statement-breakpoint
CREATE TYPE "public"."import_mode" AS ENUM('full', 'delta');--> statement-breakpoint
CREATE TYPE "public"."import_record_status" AS ENUM('staged', 'loaded', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('zendesk', 'freshdesk', 'zohodesk', 'helpscout', 'intercom', 'gorgias', 'zammad', 'front', 'file');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('draft', 'connecting', 'extracting', 'awaiting_mapping', 'dry_run', 'ready', 'loading', 'finishing', 'completed', 'failed', 'cancelled', 'paused');--> statement-breakpoint
ALTER TYPE "public"."csat_answer_channel" ADD VALUE 'import';--> statement-breakpoint
CREATE TABLE "import_external_ids" (
	"brand_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"entity" "import_entity" NOT NULL,
	"external_id" varchar(200) NOT NULL,
	"helpdock_id" uuid NOT NULL,
	"source_url" text,
	"source_number" varchar(50),
	"payload_hash" char(64) NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_external_ids_brand_id_source_entity_external_id_pk" PRIMARY KEY("brand_id","source","entity","external_id"),
	CONSTRAINT "import_external_ids_hash_shape" CHECK ("import_external_ids"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_file_presets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"entity" "import_entity" NOT NULL,
	"header_fingerprint" char(64) NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" "import_log_level" NOT NULL,
	"entity" "import_entity",
	"external_id" varchar(200),
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "import_mapping_kind" NOT NULL,
	"external_value" varchar(300) NOT NULL,
	"target" jsonb NOT NULL,
	CONSTRAINT "import_mappings_external_key" UNIQUE("run_id","kind","external_value")
);
--> statement-breakpoint
CREATE TABLE "import_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"entity" "import_entity" NOT NULL,
	"external_id" varchar(200) NOT NULL,
	"parent_external_id" varchar(200),
	"payload" jsonb NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"status" "import_record_status" DEFAULT 'staged' NOT NULL,
	"helpdock_id" uuid,
	"error" text,
	CONSTRAINT "import_records_external_key" UNIQUE("run_id","entity","external_id"),
	CONSTRAINT "import_records_hash_shape" CHECK ("import_records"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"mode" "import_mode" DEFAULT 'full' NOT NULL,
	"parent_run_id" uuid,
	"status" "import_status" DEFAULT 'draft' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" text,
	"cursors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dry_run_report" jsonb,
	"error" text,
	"started_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "import_runs_brand_id_key" UNIQUE("brand_id","id"),
	CONSTRAINT "import_runs_parent_shape" CHECK (("import_runs"."mode" = 'full' AND "import_runs"."parent_run_id" IS NULL) OR ("import_runs"."mode" = 'delta' AND "import_runs"."parent_run_id" IS NOT NULL AND "import_runs"."parent_run_id" <> "import_runs"."id")),
	CONSTRAINT "import_runs_terminal_credentials" CHECK ("import_runs"."status" NOT IN ('completed', 'failed', 'cancelled') OR "import_runs"."credentials_encrypted" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "origin" "attachment_origin" DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "author_display" varchar(200);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "import_source" "import_source";--> statement-breakpoint
ALTER TABLE "import_external_ids" ADD CONSTRAINT "import_external_ids_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_presets" ADD CONSTRAINT "import_file_presets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_presets" ADD CONSTRAINT "import_file_presets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_log" ADD CONSTRAINT "import_log_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_log" ADD CONSTRAINT "import_log_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_parent_brand_fk" FOREIGN KEY ("brand_id","parent_run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_external_ids_helpdock_idx" ON "import_external_ids" USING btree ("brand_id","entity","helpdock_id");--> statement-breakpoint
CREATE INDEX "import_external_ids_number_idx" ON "import_external_ids" USING btree ("brand_id","source_number");--> statement-breakpoint
CREATE UNIQUE INDEX "import_file_presets_name_key" ON "import_file_presets" USING btree ("brand_id",lower("name"));--> statement-breakpoint
CREATE INDEX "import_file_presets_headers_idx" ON "import_file_presets" USING btree ("brand_id","header_fingerprint");--> statement-breakpoint
CREATE INDEX "import_log_run_cursor_idx" ON "import_log" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "import_log_run_level_cursor_idx" ON "import_log" USING btree ("run_id","level","id");--> statement-breakpoint
CREATE INDEX "import_records_load_idx" ON "import_records" USING btree ("run_id","entity","status","id");--> statement-breakpoint
CREATE INDEX "import_runs_brand_created_idx" ON "import_runs" USING btree ("brand_id","created_at","id");--> statement-breakpoint
CREATE INDEX "import_runs_claim_idx" ON "import_runs" USING btree ("status","claimed_at");
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "import_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_runs_tenant_select" ON "import_runs" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_runs_tenant_insert" ON "import_runs" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_runs_tenant_update" ON "import_runs" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_runs_tenant_delete" ON "import_runs" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "import_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_records_tenant_select" ON "import_records" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_records_tenant_insert" ON "import_records" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_records_tenant_update" ON "import_records" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_records_tenant_delete" ON "import_records" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "import_mappings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_mappings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_select" ON "import_mappings" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_insert" ON "import_mappings" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_update" ON "import_mappings" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_delete" ON "import_mappings" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "import_external_ids" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_external_ids" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_external_ids_tenant_select" ON "import_external_ids" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_external_ids_tenant_insert" ON "import_external_ids" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_external_ids_tenant_update" ON "import_external_ids" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_external_ids_tenant_delete" ON "import_external_ids" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "import_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_log_tenant_select" ON "import_log" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_log_tenant_insert" ON "import_log" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_log_tenant_update" ON "import_log" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_log_tenant_delete" ON "import_log" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "import_file_presets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_file_presets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_file_presets_tenant_select" ON "import_file_presets" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_file_presets_tenant_insert" ON "import_file_presets" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_file_presets_tenant_update" ON "import_file_presets" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_file_presets_tenant_delete" ON "import_file_presets" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));

--> statement-breakpoint
UPDATE attachments SET origin = 'channel' WHERE uploader_type = 'system';
