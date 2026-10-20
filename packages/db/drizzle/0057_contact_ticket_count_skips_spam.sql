-- `helpdock_contact_ticket_count` (0055) still counted spam, so a spam ticket in
-- a department the reader cannot see showed up in the contact timeline's hidden
-- count. Spam is not a contact's history (owner decision, 1.0.2): the scoped
-- reads beside this count skip a ticket whose status is the brand's Spam, and so
-- does this. A merged ticket is still counted. Everything else about the
-- function is unchanged: see 0008 for why it borrows `app.all_departments` and
-- leaves `app.brand_ids` alone.
CREATE OR REPLACE FUNCTION public.helpdock_contact_ticket_count(p_brand_id uuid, p_contact_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = ''
SET app.all_departments = 'true'
AS $$
  SELECT pg_catalog.count(*)
  FROM public.tickets AS t
  JOIN public.ticket_statuses AS s ON s.id = t.status_id
  WHERE t.brand_id = p_brand_id
    AND t.contact_id = p_contact_id
    AND t.deleted_at IS NULL
    AND NOT s.is_spam;
$$;
