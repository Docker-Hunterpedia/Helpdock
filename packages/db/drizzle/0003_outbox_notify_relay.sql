-- Wakes the outbox relay (DOMAIN-RULES §6). Without this the relay still
-- publishes every row, one poll interval later; the notification is what makes a
-- side effect feel immediate.
--
-- NOTIFY is delivered on commit, so a rolled-back transaction wakes nobody, and
-- a committed one wakes every replica after the row is visible. The trigger is
-- per statement rather than per row: the relay reads the table and needs a nudge,
-- not a list, so an insert of a hundred rows should cost one notification.

CREATE FUNCTION public.helpdock_outbox_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_notify('outbox', '');
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER outbox_notify_relay
AFTER INSERT ON public.outbox
FOR EACH STATEMENT
EXECUTE FUNCTION public.helpdock_outbox_notify();
