ALTER TABLE "hc_article_versions" ADD COLUMN "import_embedding_deferred" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Preserve staff adoption while deferring previously imported source publications.
UPDATE "hc_article_versions" AS version
SET "import_embedding_deferred" = true
WHERE version.published_by IS NULL
  AND EXISTS (
    SELECT 1 FROM "import_external_ids" AS pointer
    WHERE pointer.brand_id = version.brand_id AND pointer.entity = 'article'
      AND pointer.helpdock_id = version.article_id
  );
