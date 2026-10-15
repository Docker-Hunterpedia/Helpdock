ALTER TABLE "hc_article_versions" ALTER COLUMN "title" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "hc_article_versions" ALTER COLUMN "published_title" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "hc_article_versions" ADD COLUMN "imported_description" text;--> statement-breakpoint
ALTER TABLE "hc_categories" ADD COLUMN "imported_parent_external_id" varchar(200);--> statement-breakpoint
ALTER TABLE "hc_categories" ADD COLUMN "imported_descriptions" jsonb;--> statement-breakpoint
ALTER TABLE "hc_sections" ADD COLUMN "imported_descriptions" jsonb;