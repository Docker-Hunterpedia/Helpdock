-- What `0007_tickets.sql` cannot express in the Drizzle schema: the trigram
-- index the ticket list's fuzzy subject search needs, and the three triggers
-- that keep the denormalised `department_id` on a ticket's children true.
--
-- DOMAIN-RULES §1.3 layer 3: "Child tables carry a denormalised `department_id`
-- kept in sync by trigger, so policies never need a join." A policy that joined
-- back to `tickets` would be a policy that reads a table whose own policy is
-- being evaluated, and it would cost a join on every row of every read.

-- Trigram matching for the ticket list's `q=` (ARCHITECTURE §1 already names
-- pg_trgm). The tsvector index answers word queries; this one answers the
-- half-typed and the misspelled, which is what an agent actually types.
-- pg_trgm is a trusted extension, so the migration owner installs it without
-- being a superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- `gin_trgm_ops` serves both `%` (similarity) and `<%` (word similarity); the
-- query uses `<%`, because a search term is one word against a whole subject
-- line and `%` compares two strings whole.
CREATE INDEX "tickets_subject_trgm_idx" ON "tickets" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint

-- Fills `department_id` from the parent ticket on the way in. Whatever a caller
-- passes is overwritten, so a caller cannot file a message under a department
-- its ticket is not in.
--
-- Deliberately *not* SECURITY DEFINER: the SELECT is subject to the caller's
-- row-level security, so a ticket the caller cannot see yields no row and the
-- insert is refused. That is the check "may this principal write to this
-- ticket" without a second place to write it.
--
-- The refusal is raised here rather than left to NOT NULL, because
-- `insufficient_privilege` with the ticket id in it is what an operator needs
-- to read; "null value in column department_id" says nothing about why.
CREATE FUNCTION public.helpdock_ticket_child_department()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  SELECT t.department_id INTO NEW.department_id
  FROM public.tickets t
  WHERE t.id = NEW.ticket_id;

  IF NEW.department_id IS NULL THEN
    RAISE EXCEPTION 'ticket % is not visible in this transaction', NEW.ticket_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ticket_messages_department
BEFORE INSERT ON public.ticket_messages
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

CREATE TRIGGER ticket_activity_department
BEFORE INSERT ON public.ticket_activity
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_ticket_child_department();--> statement-breakpoint

-- A ticket that moves department takes its thread *and* its activity log with
-- it. Without this, the messages of a ticket escalated from Support to Billing
-- would stay readable by Support and invisible to Billing, which is the
-- opposite of what the move means.
--
-- Also invoker rights: the UPDATE is bound by the same policies, so the rows
-- only move where the actor could have written them anyway.
CREATE FUNCTION public.helpdock_ticket_department_moved()
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

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tickets_department_moved
AFTER UPDATE OF department_id ON public.tickets
FOR EACH ROW
WHEN (OLD.department_id IS DISTINCT FROM NEW.department_id)
EXECUTE FUNCTION public.helpdock_ticket_department_moved();
