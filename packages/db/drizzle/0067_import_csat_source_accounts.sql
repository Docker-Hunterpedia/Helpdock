DROP INDEX "csat_responses_import_key";--> statement-breakpoint
ALTER TABLE "csat_responses" ADD COLUMN "import_source_account_key" char(64) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT c.id FROM csat_responses c JOIN import_external_ids p
      ON p.brand_id = c.brand_id AND p.source = c.imported_source
      AND p.entity = 'csat' AND p.helpdock_id = c.id
    GROUP BY c.id HAVING count(DISTINCT p.source_account_key) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot assign imported satisfaction to multiple source accounts';
  END IF;
END $$;--> statement-breakpoint
UPDATE csat_responses c SET import_source_account_key = p.source_account_key
FROM import_external_ids p WHERE p.brand_id = c.brand_id AND p.source = c.imported_source
  AND p.entity = 'csat' AND p.helpdock_id = c.id;--> statement-breakpoint
CREATE UNIQUE INDEX "csat_responses_import_key" ON "csat_responses" USING btree ("brand_id","imported_source","import_source_account_key","imported_external_id") WHERE "csat_responses"."imported_external_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_account_key_shape" CHECK ("csat_responses"."import_source_account_key" ~ '^[0-9a-f]{64}$');