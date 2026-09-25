-- M1-15: the ticket list's index set (PRD M1-15, REQUIREMENTS §5.2), checked
-- against the queries the list actually runs at 50k tickets. The plans that
-- prove each index is used are in docs/guides/tickets.md, "Performance".
--
-- Every list is ordered by the keyset `(updated_at, id)`, so every index a list
-- reads in order ends in exactly those two columns:
--
-- * `tickets_brand_updated_idx` is new. It is the default list, and every view
--   that filters rather than narrows (live states, escalated, unassigned, a
--   search): with the brand fixed, a backward scan returns the first page and
--   stops. Before it, each of those read every visible ticket and sorted them.
-- * `tickets_brand_assignee_updated_idx` replaces `(brand_id, assignee_id)`,
--   which is its prefix, so "My open" arrives already in list order.
-- * `tickets_brand_department_status_updated_idx` gains `id`, so one department
--   in one status is in keyset order too, not only in `updated_at` order.
--
-- Plain `CREATE INDEX`, not `CONCURRENTLY`: migrations run in a transaction at
-- boot, and a pre-alpha install has no table large enough for the lock to show.
DROP INDEX "tickets_brand_assignee_idx";--> statement-breakpoint
DROP INDEX "tickets_brand_department_status_updated_idx";--> statement-breakpoint
CREATE INDEX "tickets_brand_updated_idx" ON "tickets" USING btree ("brand_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tickets_brand_assignee_updated_idx" ON "tickets" USING btree ("brand_id","assignee_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tickets_brand_department_status_updated_idx" ON "tickets" USING btree ("brand_id","department_id","status_id","updated_at","id");