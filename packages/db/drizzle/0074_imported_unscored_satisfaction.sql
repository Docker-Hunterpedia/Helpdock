ALTER TABLE "csat_responses" DROP CONSTRAINT "csat_responses_origin_shape";--> statement-breakpoint
ALTER TABLE "csat_responses" DROP CONSTRAINT "csat_responses_rating_shape";--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_origin_shape" CHECK (("csat_responses"."imported_external_id" IS NULL AND "csat_responses"."imported_source" IS NULL AND "csat_responses"."closed_at" IS NOT NULL AND "csat_responses"."rated_via" IS DISTINCT FROM 'import') OR ("csat_responses"."imported_external_id" IS NOT NULL AND "csat_responses"."imported_source" IS NOT NULL AND "csat_responses"."rated_via" IS NOT DISTINCT FROM 'import' AND ("csat_responses"."rating" IS NOT NULL OR coalesce("csat_responses"."imported_details"->'ratingUnmapped' = 'true'::jsonb, false)) AND "csat_responses"."rated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_rating_shape" CHECK (("csat_responses"."rating" IS NULL AND "csat_responses"."rated_at" IS NULL) OR ("csat_responses"."rating" IS NOT NULL AND "csat_responses"."rating" BETWEEN 1 AND 5 AND "csat_responses"."rated_at" IS NOT NULL) OR ("csat_responses"."rating" IS NULL AND "csat_responses"."rated_at" IS NOT NULL AND "csat_responses"."imported_external_id" IS NOT NULL AND "csat_responses"."imported_source" IS NOT NULL AND "csat_responses"."rated_via" IS NOT DISTINCT FROM 'import' AND coalesce("csat_responses"."imported_details"->'ratingUnmapped' = 'true'::jsonb, false)));--> statement-breakpoint
-- Preserve answers from earlier M11 imports without making replay mutate historical rows.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM csat_responses c JOIN ticket_activity a ON a.id = c.id
    WHERE c.imported_external_id IS NOT NULL AND (
      a.brand_id <> c.brand_id OR a.ticket_id <> c.ticket_id OR a.action <> 'ticket.imported.event'
      OR a."to"->'sourceEvent'->>'action' IS DISTINCT FROM 'csat.response'
      OR a."to"->'sourceEvent'->>'source' IS DISTINCT FROM c.imported_source::text
      OR a."to"->'sourceEvent'->>'externalId' IS DISTINCT FROM c.imported_external_id
    )
  ) THEN
    RAISE EXCEPTION 'Imported satisfaction history ID belongs to another activity';
  END IF;
END $$;--> statement-breakpoint
INSERT INTO ticket_activity(id, brand_id, department_id, ticket_id, actor_type, actor_id, action, via, "to", created_at)
SELECT c.id, c.brand_id, c.department_id, c.ticket_id, 'system',
  'import:' || c.imported_source::text || ':system', 'ticket.imported.event', 'system',
  jsonb_build_object(
    'changes', '{}'::jsonb,
    'csat', jsonb_build_object(
      'state', CASE WHEN c.rating IS NULL THEN 'imported_unscored' ELSE 'rated' END,
      'rating', c.rating, 'comment', c.comment, 'link', NULL,
      'expiresAt', '1970-01-01T00:00:00.000Z',
      'ratedAt', to_char(c.rated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'sourceEvent', jsonb_build_object(
      'source', c.imported_source, 'externalId', c.imported_external_id,
      'action', 'csat.response', 'authorDisplay', NULL, 'authorId', NULL,
      'authorType', 'system', 'details', coalesce(c.imported_details, '{}'::jsonb)
    )
  ), c.rated_at
FROM csat_responses c
WHERE c.imported_external_id IS NOT NULL AND c.imported_source IS NOT NULL
  AND c.rated_via = 'import' AND c.rated_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ticket_activity a WHERE a.id = c.id);
