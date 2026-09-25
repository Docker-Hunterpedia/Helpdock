-- M1-15 part 2: ticket search through a token table (ADR 0011).
--
-- The list's search could not use its GIN indexes under FORCEd row-level
-- security: neither `@@` nor `<%` is LEAKPROOF, so Postgres evaluated them
-- after the policy, one visible ticket at a time, and a term that matched
-- nothing read every ticket the reader could see. `ticket_search_tokens` holds
-- one row per distinct lexeme of each ticket's subject and first message, and
-- a search becomes `token = ANY(…)` on a btree index. `texteq` and the `text`
-- range comparisons are leakproof, so the index is used ahead of the policy
-- and isolation stays in the policy (docs/guides/tickets.md, "Search under
-- row-level security").
--
-- `tickets_brand_contact_idx` serves the search's other half, "tickets whose
-- contact is called …", which until now was a filter on every visible row.

CREATE TABLE "ticket_search_tokens" (
	"ticket_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"token" text COLLATE "C" NOT NULL,
	CONSTRAINT "ticket_search_tokens_pkey" PRIMARY KEY("ticket_id","token")
);
--> statement-breakpoint
ALTER TABLE "ticket_search_tokens" ADD CONSTRAINT "ticket_search_tokens_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_search_tokens" ADD CONSTRAINT "ticket_search_tokens_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_search_tokens" ADD CONSTRAINT "ticket_search_tokens_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_search_tokens_brand_token_idx" ON "ticket_search_tokens" USING btree ("brand_id","token","ticket_id","department_id");--> statement-breakpoint
CREATE INDEX "tickets_brand_contact_idx" ON "tickets" USING btree ("brand_id","contact_id");
--> statement-breakpoint
-- The lexemes of a text, exactly as the table stores them and as a search
-- compares them: one function for both sides, so the two can never be built
-- with different configurations. `english` is the configuration
-- `tickets.search` uses (per-locale configuration is M5's). IMMUTABLE, so a
-- search term's lexemes are computed once when the statement is planned.
--
-- A lexeme longer than 200 bytes is dropped: nobody searches for one, and an
-- Arabic "word" at the parser's 2 047-character limit would not fit in a btree
-- entry, which would fail the ticket's insert rather than its search.
CREATE FUNCTION public.helpdock_search_lexemes(body text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(lexeme ORDER BY lexeme), '{}')
  FROM unnest(pg_catalog.tsvector_to_array(
    pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(body, ''))
  )) AS lexeme
  WHERE pg_catalog.octet_length(lexeme) <= 200
$$;--> statement-breakpoint

-- Rebuilds one ticket's tokens from its subject and its first message.
-- Delete-and-insert rather than a diff: a ticket has a few dozen words, and
-- one statement that states the whole answer cannot drift from it.
--
-- Invoker rights, like every trigger on a ticket's children: the reads and
-- writes are bound by the caller's policies, and `department_id` is filled by
-- `helpdock_ticket_child_department` on the way in, as for any child row.
CREATE FUNCTION public.helpdock_ticket_search_refresh(target uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.ticket_search_tokens WHERE ticket_id = target;

  INSERT INTO public.ticket_search_tokens (ticket_id, brand_id, department_id, token)
  SELECT t.id, t.brand_id, t.department_id, lexeme
  FROM public.tickets t
  CROSS JOIN LATERAL unnest(public.helpdock_search_lexemes(
    t.subject || ' ' || coalesce(
      (SELECT m.body_text FROM public.ticket_messages m WHERE m.ticket_id = t.id AND m.seq = 1),
      ''
    )
  )) AS lexeme
  WHERE t.id = target;
END;
$$;--> statement-breakpoint

CREATE FUNCTION public.helpdock_ticket_search_ticket_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM public.helpdock_ticket_search_refresh(NEW.id);
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE FUNCTION public.helpdock_ticket_search_message_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM public.helpdock_ticket_search_refresh(NEW.ticket_id);
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- A new ticket, and a subject edit. AFTER, so the row the refresh reads is the
-- one being written, in the same transaction as the write.
CREATE TRIGGER tickets_search_tokens_insert
AFTER INSERT ON public.tickets
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_search_ticket_changed();--> statement-breakpoint

CREATE TRIGGER tickets_search_tokens_subject
AFTER UPDATE OF subject ON public.tickets
FOR EACH ROW
WHEN (OLD.subject IS DISTINCT FROM NEW.subject)
EXECUTE FUNCTION public.helpdock_ticket_search_ticket_changed();--> statement-breakpoint

-- The first message: `seq = 1` is unique per ticket, so this fires once per
-- ticket, including on a split's new ticket, whose first message is the copy
-- of the first message moved to it (M1-09). A merge adds later messages to the
-- primary, which do not change what it is searched by.
CREATE TRIGGER ticket_messages_search_tokens_insert
AFTER INSERT ON public.ticket_messages
FOR EACH ROW
WHEN (NEW.seq = 1)
EXECUTE FUNCTION public.helpdock_ticket_search_message_changed();--> statement-breakpoint

CREATE TRIGGER ticket_messages_search_tokens_body
AFTER UPDATE OF body_text ON public.ticket_messages
FOR EACH ROW
WHEN (NEW.seq = 1 AND OLD.body_text IS DISTINCT FROM NEW.body_text)
EXECUTE FUNCTION public.helpdock_ticket_search_message_changed();--> statement-breakpoint

-- On the way in, the shared trigger copies the parent's department and refuses
-- a ticket the transaction cannot see, as for every other child of a ticket.
CREATE TRIGGER ticket_search_tokens_department
BEFORE INSERT ON public.ticket_search_tokens
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

-- And on a move, the ticket takes its words with it. The replacement carries
-- every child `0019` moved; add to this list, never replace it with a shorter
-- one.
CREATE OR REPLACE FUNCTION public.helpdock_ticket_department_moved()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.ticket_messages
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_activity
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.attachments
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_tags
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_participants
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.ticket_time_entries
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  UPDATE public.csat_responses
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  -- M1-15 part 2.
  UPDATE public.ticket_search_tokens
  SET department_id = NEW.department_id
  WHERE ticket_id = NEW.id;

  RETURN NULL;
END;
$$;--> statement-breakpoint

-- The tickets that exist already. FORCEd row-level security would show the
-- migration owner no ticket and no message without a tenant context, so the
-- force is lifted for the backfill, inside the migration's transaction, and
-- put back before anything else can run (as `0016` and `0017` do). The new
-- table has no policies yet: they follow below.
ALTER TABLE "tickets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_messages" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
SELECT public.helpdock_ticket_search_refresh(id) FROM public.tickets;--> statement-breakpoint
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Generated by `pnpm --filter @helpdock/db gen:rls` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- `app.*` settings the request transaction sets.
ALTER TABLE "ticket_search_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ticket_search_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_search_tokens_tenant_select" ON "ticket_search_tokens" FOR SELECT
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_search_tokens_tenant_insert" ON "ticket_search_tokens" FOR INSERT
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_search_tokens_tenant_update" ON "ticket_search_tokens" FOR UPDATE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])))
  WITH CHECK (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
--> statement-breakpoint
CREATE POLICY "ticket_search_tokens_tenant_delete" ON "ticket_search_tokens" FOR DELETE
  USING (brand_id = ANY (nullif(current_setting('app.brand_ids', true), '')::uuid[])
    AND (coalesce(nullif(current_setting('app.all_departments', true), '')::boolean, false) OR department_id = ANY (nullif(current_setting('app.department_ids', true), '')::uuid[])));
