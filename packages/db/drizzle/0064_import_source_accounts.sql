ALTER TABLE "import_external_ids" ADD COLUMN "source_account_key" char(64) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "source_account_key" char(64) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_external_ids" DROP CONSTRAINT "import_external_ids_brand_id_source_entity_external_id_pk";--> statement-breakpoint
ALTER TABLE "import_external_ids" ADD CONSTRAINT "import_external_ids_pk" PRIMARY KEY("brand_id","source","source_account_key","entity","external_id");--> statement-breakpoint
ALTER TABLE "import_external_ids" ADD CONSTRAINT "import_external_ids_account_key_shape" CHECK ("import_external_ids"."source_account_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_account_key_shape" CHECK ("import_runs"."source_account_key" ~ '^[0-9a-f]{64}$');