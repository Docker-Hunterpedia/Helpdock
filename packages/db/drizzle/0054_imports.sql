CREATE TYPE "public"."attachment_origin" AS ENUM('upload', 'channel', 'import');--> statement-breakpoint
CREATE TYPE "public"."import_entity" AS ENUM('user', 'contact', 'organization', 'group', 'field', 'tag', 'ticket', 'message', 'attachment', 'csat', 'category', 'section', 'article', 'activity');--> statement-breakpoint
CREATE TYPE "public"."import_log_level" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."import_mapping_kind" AS ENUM('status', 'priority', 'group', 'agent', 'field', 'tag', 'channel');--> statement-breakpoint
CREATE TYPE "public"."import_mode" AS ENUM('full', 'delta');--> statement-breakpoint
CREATE TYPE "public"."import_record_status" AS ENUM('staged', 'loaded', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('zendesk', 'freshdesk', 'zohodesk', 'helpscout', 'intercom', 'gorgias', 'zammad', 'front', 'file');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('draft', 'connecting', 'extracting', 'awaiting_mapping', 'dry_run', 'ready', 'loading', 'finishing', 'completed', 'failed', 'cancelled', 'paused');--> statement-breakpoint
ALTER TYPE "public"."csat_answer_channel" ADD VALUE 'import';--> statement-breakpoint
ALTER TYPE "public"."ticket_participant_source" ADD VALUE 'import';--> statement-breakpoint
CREATE TABLE "hc_import_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"source_account_key" char(64) NOT NULL,
	"parent_external_id" varchar(200) NOT NULL,
	"asset_external_id" varchar(200) NOT NULL,
	"locale" "locale" NOT NULL,
	"usage" varchar(8) NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"content_hash" char(64) NOT NULL,
	"media_id" uuid NOT NULL,
	"article_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hc_import_assets_hashes_check" CHECK ("hc_import_assets"."source_account_key" ~ '^[0-9a-f]{64}$' AND "hc_import_assets"."payload_hash" ~ '^[0-9a-f]{64}$' AND "hc_import_assets"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "hc_import_assets_usage_check" CHECK ("hc_import_assets"."usage" IN ('image', 'download'))
);
--> statement-breakpoint
CREATE TABLE "import_external_ids" (
	"brand_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"source_account_key" char(64) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
	"entity" "import_entity" NOT NULL,
	"external_id" varchar(200) NOT NULL,
	"helpdock_id" uuid NOT NULL,
	"source_url" text,
	"source_number" varchar(50),
	"payload_hash" char(64) NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_external_ids_pk" PRIMARY KEY("brand_id","source","source_account_key","entity","external_id"),
	CONSTRAINT "import_external_ids_account_key_shape" CHECK ("import_external_ids"."source_account_key" ~ '^[0-9a-f]{64}$'),
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
CREATE TABLE "import_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"format" varchar(10) NOT NULL,
	"entity" "import_entity",
	"size" bigint NOT NULL,
	"upload_key" text NOT NULL,
	"source_key" text,
	"preparation_key" text,
	"sha256" char(64),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"headers" jsonb,
	"sample_rows" jsonb,
	"mapping" jsonb,
	"inventory_mapping" jsonb,
	"inventory_validation" jsonb,
	"validation" jsonb,
	"record_count" integer,
	"error" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_files_brand_run_id_key" UNIQUE("brand_id","run_id","id"),
	CONSTRAINT "import_files_size" CHECK ("import_files"."size" > 0 AND "import_files"."size" <= 2147483648),
	CONSTRAINT "import_files_format" CHECK (("import_files"."format" = 'csv' AND "import_files"."entity" IS NOT NULL) OR ("import_files"."format" = 'bundle' AND "import_files"."entity" IS NULL)),
	CONSTRAINT "import_files_status" CHECK ("import_files"."status" IN ('pending', 'uploaded', 'ready', 'invalid', 'discarded')),
	CONSTRAINT "import_files_sealed" CHECK ("import_files"."status" <> 'ready' OR ("import_files"."source_key" IS NOT NULL AND "import_files"."sha256" IS NOT NULL AND "import_files"."sha256" ~ '^[0-9a-f]{64}$'))
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
CREATE TABLE "import_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"request_hash" char(64) NOT NULL,
	"response" jsonb NOT NULL,
	CONSTRAINT "import_pages_request_key" UNIQUE("run_id","request_hash"),
	CONSTRAINT "import_pages_hash_shape" CHECK ("import_pages"."request_hash" ~ '^[0-9a-f]{64}$')
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
	"load_hash" char(64),
	"dry_run_identity" jsonb,
	"dry_run_media" jsonb,
	"prepared_assets" jsonb,
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
	"source_account_key" char(64) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
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
	"claim_token" uuid,
	"paused_from" "import_status",
	CONSTRAINT "import_runs_brand_id_key" UNIQUE("brand_id","id"),
	CONSTRAINT "import_runs_account_key_shape" CHECK ("import_runs"."source_account_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_runs_parent_shape" CHECK (("import_runs"."mode" = 'full' AND "import_runs"."parent_run_id" IS NULL) OR ("import_runs"."mode" = 'delta' AND "import_runs"."parent_run_id" IS NOT NULL AND "import_runs"."parent_run_id" <> "import_runs"."id")),
	CONSTRAINT "import_runs_terminal_credentials" CHECK ("import_runs"."status" NOT IN ('completed', 'failed', 'cancelled') OR "import_runs"."credentials_encrypted" IS NULL),
	CONSTRAINT "import_runs_claim_shape" CHECK (("import_runs"."claim_token" IS NULL AND "import_runs"."claimed_at" IS NULL) OR ("import_runs"."claim_token" IS NOT NULL AND "import_runs"."claimed_at" IS NOT NULL AND "import_runs"."status" IN ('extracting', 'dry_run', 'loading', 'finishing'))),
	CONSTRAINT "import_runs_pause_shape" CHECK (("import_runs"."status" = 'paused' AND "import_runs"."paused_from" IS NOT NULL AND "import_runs"."paused_from" IN ('extracting', 'dry_run', 'loading', 'finishing')) OR ("import_runs"."status" <> 'paused' AND "import_runs"."paused_from" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "import_ticket_inventory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"source_hash" char(64) NOT NULL,
	"external_id" varchar(200) NOT NULL,
	"location" varchar(8) NOT NULL,
	"line" bigint NOT NULL,
	CONSTRAINT "import_ticket_inventory_id_shape" CHECK ("import_ticket_inventory"."external_id" ~ '^[!-~]+$'),
	CONSTRAINT "import_ticket_inventory_hash_shape" CHECK ("import_ticket_inventory"."source_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_ticket_inventory_location" CHECK ("import_ticket_inventory"."location" IN ('active', 'archived', 'auto')),
	CONSTRAINT "import_ticket_inventory_line" CHECK ("import_ticket_inventory"."line" > 0 AND "import_ticket_inventory"."line" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "csat_responses" DROP CONSTRAINT "csat_responses_rating_shape";--> statement-breakpoint
DROP INDEX "csat_responses_ticket_close_key";--> statement-breakpoint
DROP INDEX "ticket_activity_ticket_created_idx";--> statement-breakpoint
DROP INDEX "ticket_messages_external_key";--> statement-breakpoint
ALTER TABLE "csat_responses" ALTER COLUMN "closed_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_article_versions" ALTER COLUMN "title" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "hc_article_versions" ALTER COLUMN "published_title" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "imported_details" jsonb;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "origin" "attachment_origin" DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "imported_details" jsonb;--> statement-breakpoint
ALTER TABLE "csat_responses" ADD COLUMN "imported_source" "import_source";--> statement-breakpoint
ALTER TABLE "csat_responses" ADD COLUMN "import_source_account_key" char(64) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "csat_responses" ADD COLUMN "imported_external_id" varchar(200);--> statement-breakpoint
ALTER TABLE "csat_responses" ADD COLUMN "imported_details" jsonb;--> statement-breakpoint
ALTER TABLE "hc_article_versions" ADD COLUMN "imported_description" text;--> statement-breakpoint
ALTER TABLE "hc_article_versions" ADD COLUMN "imported_published_description" text;--> statement-breakpoint
ALTER TABLE "hc_article_versions" ADD COLUMN "import_embedding_deferred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_categories" ADD COLUMN "imported_parent_external_id" varchar(200);--> statement-breakpoint
ALTER TABLE "hc_categories" ADD COLUMN "imported_descriptions" jsonb;--> statement-breakpoint
ALTER TABLE "hc_media" ADD COLUMN "kind" varchar(8) DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_media" ADD COLUMN "scan_status" "attachment_scan_status" DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_media" ADD COLUMN "imported_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "hc_sections" ADD COLUMN "imported_descriptions" jsonb;--> statement-breakpoint
ALTER TABLE "hc_sections" ADD COLUMN "imported_parent_section_external_id" varchar(200);--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "author_display" varchar(200);--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "import_details" jsonb;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "import_source_account_key" char(64);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "import_source" "import_source";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "import_sla_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hc_articles" ADD CONSTRAINT "hc_articles_brand_id_key" UNIQUE("brand_id","id");--> statement-breakpoint
ALTER TABLE "hc_media" ADD CONSTRAINT "hc_media_brand_id_key" UNIQUE("brand_id","id");--> statement-breakpoint
ALTER TABLE "hc_import_assets" ADD CONSTRAINT "hc_import_assets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_import_assets" ADD CONSTRAINT "hc_import_assets_media_brand_fk" FOREIGN KEY ("brand_id","media_id") REFERENCES "public"."hc_media"("brand_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_import_assets" ADD CONSTRAINT "hc_import_assets_article_brand_fk" FOREIGN KEY ("brand_id","article_id") REFERENCES "public"."hc_articles"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_external_ids" ADD CONSTRAINT "import_external_ids_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_presets" ADD CONSTRAINT "import_file_presets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_presets" ADD CONSTRAINT "import_file_presets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_log" ADD CONSTRAINT "import_log_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_log" ADD CONSTRAINT "import_log_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pages" ADD CONSTRAINT "import_pages_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pages" ADD CONSTRAINT "import_pages_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_brand_id_run_id_import_runs_brand_id_id_fk" FOREIGN KEY ("brand_id","run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_parent_brand_fk" FOREIGN KEY ("brand_id","parent_run_id") REFERENCES "public"."import_runs"("brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_ticket_inventory" ADD CONSTRAINT "import_ticket_inventory_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_ticket_inventory" ADD CONSTRAINT "import_ticket_inventory_file_fk" FOREIGN KEY ("brand_id","run_id","file_id") REFERENCES "public"."import_files"("brand_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hc_import_assets_identity_key" ON "hc_import_assets" USING btree ("brand_id","source","source_account_key","parent_external_id","locale","asset_external_id","usage","payload_hash","content_hash");--> statement-breakpoint
CREATE INDEX "hc_import_assets_media_idx" ON "hc_import_assets" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "hc_import_assets_article_idx" ON "hc_import_assets" USING btree ("brand_id","article_id","locale");--> statement-breakpoint
CREATE INDEX "hc_import_assets_created_idx" ON "hc_import_assets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "import_external_ids_helpdock_idx" ON "import_external_ids" USING btree ("brand_id","entity","helpdock_id");--> statement-breakpoint
CREATE INDEX "import_external_ids_number_idx" ON "import_external_ids" USING btree ("brand_id","source_number");--> statement-breakpoint
CREATE INDEX "import_external_ids_native_lookup_idx" ON "import_external_ids" USING btree ("brand_id","entity","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_file_presets_name_key" ON "import_file_presets" USING btree ("brand_id",lower("name"));--> statement-breakpoint
CREATE INDEX "import_file_presets_headers_idx" ON "import_file_presets" USING btree ("brand_id","header_fingerprint");--> statement-breakpoint
CREATE INDEX "import_files_run_idx" ON "import_files" USING btree ("brand_id","run_id","id");--> statement-breakpoint
CREATE INDEX "import_files_work_idx" ON "import_files" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "import_log_run_cursor_idx" ON "import_log" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "import_log_run_level_cursor_idx" ON "import_log" USING btree ("run_id","level","id");--> statement-breakpoint
CREATE INDEX "import_records_parent_idx" ON "import_records" USING btree ("run_id","parent_external_id","entity");--> statement-breakpoint
CREATE INDEX "import_records_load_idx" ON "import_records" USING btree ("run_id","entity","status","id");--> statement-breakpoint
CREATE INDEX "import_records_article_translation_idx" ON "import_records" USING btree ("brand_id","run_id",("payload" ->> 'translationOf')) WHERE "import_records"."entity" = 'article';--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_brand_claim_key" ON "import_runs" USING btree ("brand_id") WHERE "import_runs"."claim_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "import_runs_brand_created_idx" ON "import_runs" USING btree ("brand_id","created_at","id");--> statement-breakpoint
CREATE INDEX "import_runs_brand_finished_idx" ON "import_runs" USING btree ("brand_id","finished_at","id") WHERE "import_runs"."finished_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "import_runs_claim_idx" ON "import_runs" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_ticket_inventory_native_key" ON "import_ticket_inventory" USING btree ("file_id","revision","source_hash","external_id");--> statement-breakpoint
CREATE INDEX "import_ticket_inventory_run_idx" ON "import_ticket_inventory" USING btree ("brand_id","run_id","external_id" COLLATE "C");--> statement-breakpoint
CREATE UNIQUE INDEX "csat_responses_import_key" ON "csat_responses" USING btree ("brand_id","imported_source","import_source_account_key","imported_external_id") WHERE "csat_responses"."imported_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hc_media_import_candidates_idx" ON "hc_media" USING btree ("created_at","id") WHERE "hc_media"."imported_by_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ticket_messages_reference_idx" ON "ticket_messages" USING btree ("brand_id","channel","external_message_id") WHERE "ticket_messages"."external_message_id" is not null;--> statement-breakpoint
CREATE INDEX "tickets_import_sla_pending_idx" ON "tickets" USING btree ("brand_id","import_source","id") WHERE "tickets"."imported_at" IS NOT NULL AND "tickets"."import_sla_started_at" IS NULL AND "tickets"."deleted_at" IS NULL AND "tickets"."merged_into_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "csat_responses_ticket_close_key" ON "csat_responses" USING btree ("ticket_id","closed_at") WHERE "csat_responses"."imported_external_id" IS NULL;--> statement-breakpoint
CREATE INDEX "ticket_activity_ticket_created_idx" ON "ticket_activity" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_external_key" ON "ticket_messages" USING btree ("brand_id","channel","external_message_id") WHERE "ticket_messages"."external_message_id" is not null AND "ticket_messages"."import_source_account_key" is null;--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_account_key_shape" CHECK ("csat_responses"."import_source_account_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_origin_shape" CHECK (("csat_responses"."imported_external_id" IS NULL AND "csat_responses"."imported_source" IS NULL AND "csat_responses"."closed_at" IS NOT NULL AND "csat_responses"."rated_via"::text IS DISTINCT FROM 'import') OR ("csat_responses"."imported_external_id" IS NOT NULL AND "csat_responses"."imported_source" IS NOT NULL AND "csat_responses"."rated_via"::text IS NOT DISTINCT FROM 'import' AND ("csat_responses"."rating" IS NOT NULL OR coalesce("csat_responses"."imported_details"->'ratingUnmapped' = 'true'::jsonb, false)) AND "csat_responses"."rated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_rating_shape" CHECK (("csat_responses"."rating" IS NULL AND "csat_responses"."rated_at" IS NULL) OR ("csat_responses"."rating" IS NOT NULL AND "csat_responses"."rating" BETWEEN 1 AND 5 AND "csat_responses"."rated_at" IS NOT NULL) OR ("csat_responses"."rating" IS NULL AND "csat_responses"."rated_at" IS NOT NULL AND "csat_responses"."imported_external_id" IS NOT NULL AND "csat_responses"."imported_source" IS NOT NULL AND "csat_responses"."rated_via"::text IS NOT DISTINCT FROM 'import' AND coalesce("csat_responses"."imported_details"->'ratingUnmapped' = 'true'::jsonb, false)));--> statement-breakpoint
ALTER TABLE "hc_media" ADD CONSTRAINT "hc_media_kind_check" CHECK ("hc_media"."kind" IN ('image', 'file'));--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_import_account_key_shape" CHECK ("ticket_messages"."import_source_account_key" IS NULL OR "ticket_messages"."import_source_account_key" ~ '^[0-9a-f]{64}$');
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
ALTER TABLE "import_pages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_pages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_pages_tenant_select" ON "import_pages" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_pages_tenant_insert" ON "import_pages" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_pages_tenant_update" ON "import_pages" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_pages_tenant_delete" ON "import_pages" FOR DELETE
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
ALTER TABLE "import_files" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_files_tenant_select" ON "import_files" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_files_tenant_insert" ON "import_files" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_files_tenant_update" ON "import_files" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_files_tenant_delete" ON "import_files" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "import_ticket_inventory" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_ticket_inventory" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_ticket_inventory_tenant_select" ON "import_ticket_inventory" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_ticket_inventory_tenant_insert" ON "import_ticket_inventory" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_ticket_inventory_tenant_update" ON "import_ticket_inventory" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "import_ticket_inventory_tenant_delete" ON "import_ticket_inventory" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_import_assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_import_assets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_import_assets_tenant_select" ON "hc_import_assets" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_import_assets_tenant_insert" ON "hc_import_assets" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_import_assets_tenant_update" ON "hc_import_assets" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_import_assets_tenant_delete" ON "hc_import_assets" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));

--> statement-breakpoint
-- Existing system uploads were channel media before origin was explicit.
UPDATE attachments SET origin = 'channel' WHERE uploader_type = 'system';
--> statement-breakpoint
CREATE FUNCTION discard_import_pages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'extracting' AND NOT (NEW.status = 'paused' AND NEW.paused_from = 'extracting') THEN
    DELETE FROM import_pages WHERE brand_id = NEW.brand_id AND run_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_pages_cleanup AFTER UPDATE OF status ON import_runs
FOR EACH ROW EXECUTE FUNCTION discard_import_pages();
