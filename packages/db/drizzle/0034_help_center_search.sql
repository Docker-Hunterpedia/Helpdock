-- M5-05, M5-08: help center search, its log, article views and feedback.
-- hc_search_documents is the search index, written by the search subscriber
-- from the help_center.* events and the hourly reconcile (which also fills it
-- on an install that already had published articles); the other three feed
-- the Insights tab. Every table is a brand-scoped tenant table (TENANT_TABLES
-- in src/rls.ts). The pg_trgm extension comes from 0008.
CREATE TYPE "public"."hc_search_source" AS ENUM('help_center', 'widget');--> statement-breakpoint
CREATE TABLE "hc_article_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"locale" "locale" NOT NULL,
	"visitor_hash" varchar(64) NOT NULL,
	"helpful" boolean NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hc_article_views" (
	"brand_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"visitor_hash" varchar(64) NOT NULL,
	"day" date NOT NULL,
	"locale" "locale" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hc_article_views_article_id_visitor_hash_day_pk" PRIMARY KEY("article_id","visitor_hash","day")
);
--> statement-breakpoint
CREATE TABLE "hc_search_documents" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"locale" "locale" NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"title_normalized" text GENERATED ALWAYS AS (lower(translate(regexp_replace("title", '[\u064B-\u065F\u0670\u0640]', '', 'g'), 'أإآٱىة', 'اااايه'))) STORED,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "title"), 'A')
      || setweight(to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "description"), 'B')
      || setweight(to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "body_text"), 'C')) STORED,
	"source_changed_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hc_search_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"query" varchar(200) NOT NULL,
	"locale" "locale" NOT NULL,
	"source" "hc_search_source" NOT NULL,
	"hits" integer NOT NULL,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hc_article_feedback" ADD CONSTRAINT "hc_article_feedback_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_article_feedback" ADD CONSTRAINT "hc_article_feedback_article_id_hc_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."hc_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_article_feedback" ADD CONSTRAINT "hc_article_feedback_version_id_hc_article_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."hc_article_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_article_views" ADD CONSTRAINT "hc_article_views_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_article_views" ADD CONSTRAINT "hc_article_views_article_id_hc_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."hc_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_search_documents" ADD CONSTRAINT "hc_search_documents_version_id_hc_article_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."hc_article_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_search_documents" ADD CONSTRAINT "hc_search_documents_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_search_documents" ADD CONSTRAINT "hc_search_documents_article_id_hc_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."hc_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_search_log" ADD CONSTRAINT "hc_search_log_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hc_article_feedback_version_visitor_key" ON "hc_article_feedback" USING btree ("version_id","visitor_hash");--> statement-breakpoint
CREATE INDEX "hc_article_feedback_brand_updated_idx" ON "hc_article_feedback" USING btree ("brand_id","updated_at");--> statement-breakpoint
CREATE INDEX "hc_article_views_brand_day_idx" ON "hc_article_views" USING btree ("brand_id","day");--> statement-breakpoint
CREATE INDEX "hc_search_documents_brand_locale_idx" ON "hc_search_documents" USING btree ("brand_id","locale");--> statement-breakpoint
CREATE INDEX "hc_search_documents_article_idx" ON "hc_search_documents" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "hc_search_log_brand_created_idx" ON "hc_search_log" USING btree ("brand_id","created_at");
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "hc_search_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_search_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_search_documents_tenant_select" ON "hc_search_documents" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_search_documents_tenant_insert" ON "hc_search_documents" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_search_documents_tenant_update" ON "hc_search_documents" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_search_documents_tenant_delete" ON "hc_search_documents" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_search_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_search_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_search_log_tenant_select" ON "hc_search_log" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_search_log_tenant_insert" ON "hc_search_log" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_search_log_tenant_update" ON "hc_search_log" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_search_log_tenant_delete" ON "hc_search_log" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_article_views" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_article_views" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_article_views_tenant_select" ON "hc_article_views" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_views_tenant_insert" ON "hc_article_views" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_views_tenant_update" ON "hc_article_views" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_views_tenant_delete" ON "hc_article_views" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_article_feedback" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_article_feedback" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_article_feedback_tenant_select" ON "hc_article_feedback" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_feedback_tenant_insert" ON "hc_article_feedback" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_feedback_tenant_update" ON "hc_article_feedback" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_feedback_tenant_delete" ON "hc_article_feedback" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
