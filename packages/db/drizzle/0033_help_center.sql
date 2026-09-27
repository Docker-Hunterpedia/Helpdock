-- M5-01, M5-02, M5-09: help center content. Category -> section -> article,
-- one version per locale with a working copy and a published copy, the
-- brand's help center access mode, and article images. Every table is a
-- brand-scoped tenant table (TENANT_TABLES in src/rls.ts); none is
-- department-scoped, because help center content belongs to the brand.
CREATE TYPE "public"."hc_access" AS ENUM('public', 'internal_only');--> statement-breakpoint
CREATE TYPE "public"."hc_article_status" AS ENUM('draft', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."hc_media_status" AS ENUM('pending', 'processing', 'ready', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hc_visibility" AS ENUM('public', 'internal');--> statement-breakpoint
CREATE TABLE "hc_article_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"locale" "locale" NOT NULL,
	"status" "hc_article_status" DEFAULT 'draft' NOT NULL,
	"visibility" "hc_visibility" DEFAULT 'public' NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" varchar(160) DEFAULT '' NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"published_title" varchar(200),
	"published_description" varchar(160),
	"published_body_html" text,
	"published_body_text" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"scheduled_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hc_articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"slug" varchar(120) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hc_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"slug" varchar(120) NOT NULL,
	"names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"descriptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hc_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"status" "hc_media_status" DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"webp_key" text,
	"width" integer,
	"height" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hc_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" varchar(120) NOT NULL,
	"names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hc_settings" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"access" "hc_access" DEFAULT 'public' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hc_article_versions" ADD CONSTRAINT "hc_article_versions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_article_versions" ADD CONSTRAINT "hc_article_versions_article_id_hc_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."hc_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_articles" ADD CONSTRAINT "hc_articles_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_articles" ADD CONSTRAINT "hc_articles_section_id_hc_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."hc_sections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_articles" ADD CONSTRAINT "hc_articles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_categories" ADD CONSTRAINT "hc_categories_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_media" ADD CONSTRAINT "hc_media_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_sections" ADD CONSTRAINT "hc_sections_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_sections" ADD CONSTRAINT "hc_sections_category_id_hc_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."hc_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD CONSTRAINT "hc_settings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hc_article_versions_article_locale_key" ON "hc_article_versions" USING btree ("article_id","locale");--> statement-breakpoint
CREATE INDEX "hc_article_versions_scheduled_idx" ON "hc_article_versions" USING btree ("brand_id","scheduled_at") WHERE "hc_article_versions"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "hc_article_versions_changed_idx" ON "hc_article_versions" USING btree ("brand_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hc_articles_brand_slug_key" ON "hc_articles" USING btree ("brand_id","slug");--> statement-breakpoint
CREATE INDEX "hc_articles_section_idx" ON "hc_articles" USING btree ("section_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "hc_categories_brand_slug_key" ON "hc_categories" USING btree ("brand_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "hc_media_s3_key_key" ON "hc_media" USING btree ("s3_key");--> statement-breakpoint
CREATE UNIQUE INDEX "hc_sections_brand_slug_key" ON "hc_sections" USING btree ("brand_id","slug");--> statement-breakpoint
CREATE INDEX "hc_sections_category_idx" ON "hc_sections" USING btree ("category_id","position");
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "hc_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_categories_tenant_select" ON "hc_categories" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_categories_tenant_insert" ON "hc_categories" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_categories_tenant_update" ON "hc_categories" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_categories_tenant_delete" ON "hc_categories" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_sections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_sections_tenant_select" ON "hc_sections" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_sections_tenant_insert" ON "hc_sections" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_sections_tenant_update" ON "hc_sections" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_sections_tenant_delete" ON "hc_sections" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_articles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_articles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_articles_tenant_select" ON "hc_articles" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_articles_tenant_insert" ON "hc_articles" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_articles_tenant_update" ON "hc_articles" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_articles_tenant_delete" ON "hc_articles" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_article_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_article_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_article_versions_tenant_select" ON "hc_article_versions" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_versions_tenant_insert" ON "hc_article_versions" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_versions_tenant_update" ON "hc_article_versions" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_article_versions_tenant_delete" ON "hc_article_versions" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_settings_tenant_select" ON "hc_settings" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_settings_tenant_insert" ON "hc_settings" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_settings_tenant_update" ON "hc_settings" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_settings_tenant_delete" ON "hc_settings" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
ALTER TABLE "hc_media" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hc_media" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hc_media_tenant_select" ON "hc_media" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_media_tenant_insert" ON "hc_media" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_media_tenant_update" ON "hc_media" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
--> statement-breakpoint
CREATE POLICY "hc_media_tenant_delete" ON "hc_media" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[]));
