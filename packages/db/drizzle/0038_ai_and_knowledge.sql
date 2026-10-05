-- M7-01, M7-02, M7-08: the AI call log, a brand's AI settings and budget
-- alerts, the knowledge tables, and the install's single embedding space
-- (ADR 0005). The `vector(<dims>)` column is deliberately absent: it is created
-- by `knowledge.configure` through `helpdock_set_embedding_dims` below, once
-- the install's embedding model says what the dimension is.

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."ai_budget_level" AS ENUM('warning', 'exceeded');--> statement-breakpoint
CREATE TYPE "public"."ai_budget_period" AS ENUM('day', 'month');--> statement-breakpoint
CREATE TYPE "public"."ai_call_status" AS ENUM('ok', 'error', 'refused');--> statement-breakpoint
CREATE TYPE "public"."embedding_status" AS ENUM('unconfigured', 'reindexing', 'ready');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_kind" AS ENUM('article', 'file', 'crawl', 'notion', 'gdrive');--> statement-breakpoint
CREATE TYPE "public"."knowledge_sync_status" AS ENUM('idle', 'queued', 'syncing', 'ok', 'failed');--> statement-breakpoint
CREATE TABLE "ai_budget_alerts" (
	"brand_id" uuid NOT NULL,
	"period" "ai_budget_period" NOT NULL,
	"period_start" date NOT NULL,
	"level" "ai_budget_level" NOT NULL,
	"spent_usd" numeric(14, 6) NOT NULL,
	"limit_usd" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_budget_alerts_brand_id_period_period_start_level_pk" PRIMARY KEY("brand_id","period","period_start","level")
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"ticket_id" uuid,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "ai_call_status" NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"redaction_count" integer DEFAULT 0 NOT NULL,
	"prompt_hash" text,
	"prompt" jsonb,
	"response" text,
	"redactions" jsonb,
	"sources" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bodies_purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"provider_id" text,
	"model_id" text,
	"system_prompt" text DEFAULT '' NOT NULL,
	"pii_redaction" boolean DEFAULT true NOT NULL,
	"injection_filter" boolean DEFAULT true NOT NULL,
	"daily_budget_usd" numeric(12, 4),
	"monthly_budget_usd" numeric(12, 4),
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_daily_budget_check" CHECK ("ai_settings"."daily_budget_usd" IS NULL OR "ai_settings"."daily_budget_usd" > 0),
	CONSTRAINT "ai_settings_monthly_budget_check" CHECK ("ai_settings"."monthly_budget_usd" IS NULL OR "ai_settings"."monthly_budget_usd" > 0),
	CONSTRAINT "ai_settings_model_pair_check" CHECK (("ai_settings"."provider_id" IS NULL) = ("ai_settings"."model_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "embedding_space" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"status" "embedding_status" DEFAULT 'unconfigured' NOT NULL,
	"active_model" text,
	"active_dims" integer,
	"target_provider" text,
	"target_model" text,
	"target_dims" integer,
	"column_dims" integer,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_space_singleton_check" CHECK ("embedding_space"."singleton")
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"article_id" uuid,
	"ordinal" integer NOT NULL,
	"locale" text NOT NULL,
	"visibility" "hc_visibility" NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"suspicious" boolean DEFAULT false NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "content")) STORED,
	"embedding_model" text,
	"embedded_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"url" text,
	"article_id" uuid,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_source_external_key" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" "knowledge_source_kind" NOT NULL,
	"name" text NOT NULL,
	"visibility" "hc_visibility" DEFAULT 'internal' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_encrypted" text,
	"sync_status" "knowledge_sync_status" DEFAULT 'idle' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_budget_alerts" ADD CONSTRAINT "ai_budget_alerts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_article_id_hc_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."hc_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_article_id_hc_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."hc_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_brand_created_idx" ON "ai_calls" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_ticket_idx" ON "ai_calls" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_brand_source_idx" ON "knowledge_chunks" USING btree ("brand_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document_idx" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_brand_model_idx" ON "knowledge_chunks" USING btree ("brand_id","embedding_model");--> statement-breakpoint
CREATE INDEX "knowledge_sources_brand_idx" ON "knowledge_sources" USING btree ("brand_id");--> statement-breakpoint
INSERT INTO "embedding_space" ("singleton", "status") VALUES (true, 'unconfigured') ON CONFLICT DO NOTHING;--> statement-breakpoint

-- DDL the runtime role must not have (DOMAIN-RULES §1.5), run with the owner's
-- rights the way the brand ticket sequence is. The dimension is an integer
-- checked against pgvector's 2,000-dimension HNSW ceiling and formatted with
-- %s, so nothing a caller passes becomes SQL. The index is dropped first, so a
-- change of dimension never leaves an index over the wrong column, and the
-- column is replaced only when its dimension changes: vectors of the same
-- dimension stay where they are until the re-embed overwrites them, and
-- retrieval ignores them meanwhile because their `embedding_model` is not the
-- active one.
CREATE FUNCTION public.helpdock_set_embedding_dims(dims integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_dims integer;
BEGIN
  IF dims IS NULL OR dims < 1 OR dims > 2000 THEN
    RAISE EXCEPTION 'An embedding dimension must be between 1 and 2000 (ADR 0005), got %', dims;
  END IF;

  DROP INDEX IF EXISTS public.knowledge_chunks_embedding_hnsw_idx;

  SELECT attribute.atttypmod INTO current_dims
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.knowledge_chunks'::regclass
    AND attribute.attname = 'embedding'
    AND NOT attribute.attisdropped;

  IF current_dims IS DISTINCT FROM dims THEN
    ALTER TABLE public.knowledge_chunks DROP COLUMN IF EXISTS embedding;
    EXECUTE format('ALTER TABLE public.knowledge_chunks ADD COLUMN embedding public.vector(%s)', dims);
  END IF;
END
$$;--> statement-breakpoint

CREATE FUNCTION public.helpdock_build_embedding_index()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
    ON public.knowledge_chunks USING hnsw (embedding public.vector_cosine_ops);
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.helpdock_set_embedding_dims(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.helpdock_build_embedding_index() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.helpdock_set_embedding_dims(integer) TO helpdock_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.helpdock_build_embedding_index() TO helpdock_app;
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "ai_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_settings_tenant_select" ON "ai_settings" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_settings_tenant_insert" ON "ai_settings" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_settings_tenant_update" ON "ai_settings" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_settings_tenant_delete" ON "ai_settings" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_calls_tenant_select" ON "ai_calls" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_calls_tenant_insert" ON "ai_calls" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_calls_tenant_update" ON "ai_calls" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_calls_tenant_delete" ON "ai_calls" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "ai_budget_alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_budget_alerts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_budget_alerts_tenant_select" ON "ai_budget_alerts" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_budget_alerts_tenant_insert" ON "ai_budget_alerts" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_budget_alerts_tenant_update" ON "ai_budget_alerts" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "ai_budget_alerts_tenant_delete" ON "ai_budget_alerts" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_sources_tenant_select" ON "knowledge_sources" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_sources_tenant_insert" ON "knowledge_sources" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_sources_tenant_update" ON "knowledge_sources" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_sources_tenant_delete" ON "knowledge_sources" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_documents_tenant_select" ON "knowledge_documents" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_documents_tenant_insert" ON "knowledge_documents" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_documents_tenant_update" ON "knowledge_documents" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_documents_tenant_delete" ON "knowledge_documents" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_chunks_tenant_select" ON "knowledge_chunks" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_chunks_tenant_insert" ON "knowledge_chunks" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_chunks_tenant_update" ON "knowledge_chunks" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "knowledge_chunks_tenant_delete" ON "knowledge_chunks" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
