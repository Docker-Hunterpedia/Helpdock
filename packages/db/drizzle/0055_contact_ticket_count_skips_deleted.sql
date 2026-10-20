-- `helpdock_contact_ticket_count` (0008) counted soft-deleted tickets, so a
-- deleted ticket in a department the reader cannot see still showed up in the
-- contact timeline's hidden count. DOMAIN-RULES §2.2 says a deleted ticket is
-- "hidden from all views", and the scoped reads beside this count now skip
-- them too. Everything else about the function is unchanged: see 0008 for why
-- it borrows `app.all_departments` and leaves `app.brand_ids` alone.
CREATE OR REPLACE FUNCTION public.helpdock_contact_ticket_count(p_brand_id uuid, p_contact_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = ''
SET app.all_departments = 'true'
AS $$
  SELECT pg_catalog.count(*)
  FROM public.tickets
  WHERE brand_id = p_brand_id AND contact_id = p_contact_id AND deleted_at IS NULL;
$$;
