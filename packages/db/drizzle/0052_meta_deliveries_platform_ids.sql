-- M10-06: a status webhook names one of Meta's ids (`wamid.…` or `mid`) and finds its
-- delivery with `platform_message_ids @> array[id]`. A GIN index serves that query;
-- without it every status report scanned the brand's deliveries two or three times.
CREATE INDEX "meta_deliveries_platform_ids_idx" ON "meta_deliveries" USING gin ("platform_message_ids");