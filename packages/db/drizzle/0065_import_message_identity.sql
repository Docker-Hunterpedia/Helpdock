DROP INDEX "ticket_messages_external_key";--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "import_source_account_key" char(64);--> statement-breakpoint
CREATE INDEX "ticket_messages_reference_idx" ON "ticket_messages" USING btree ("brand_id","channel","external_message_id") WHERE "ticket_messages"."external_message_id" is not null;--> statement-breakpoint
UPDATE ticket_messages m SET import_source_account_key = i.source_account_key
FROM import_external_ids i WHERE i.brand_id = m.brand_id AND i.entity = 'message' AND i.helpdock_id = m.id;
--> statement-breakpoint
WITH RECURSIVE imported_copies AS (
  SELECT id, brand_id, import_source_account_key FROM ticket_messages WHERE import_source_account_key IS NOT NULL
  UNION
  SELECT child.id, child.brand_id, parent.import_source_account_key
  FROM ticket_messages child JOIN imported_copies parent ON child.copied_from_message_id = parent.id AND child.brand_id = parent.brand_id
)
UPDATE ticket_messages m SET import_source_account_key = c.import_source_account_key
FROM imported_copies c WHERE m.id = c.id AND m.brand_id = c.brand_id AND m.import_source_account_key IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_external_key" ON "ticket_messages" USING btree ("brand_id","channel","external_message_id") WHERE "ticket_messages"."external_message_id" is not null AND "ticket_messages"."import_source_account_key" is null;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_import_account_key_shape" CHECK ("ticket_messages"."import_source_account_key" IS NULL OR "ticket_messages"."import_source_account_key" ~ '^[0-9a-f]{64}$');