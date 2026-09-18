-- The runtime role of DOMAIN-RULES §1.5 and the per-brand ticket sequences of
-- ARCHITECTURE §5. Migrations run as the owner; everything below is what the
-- owner hands to the role that serves traffic.

-- The password arrives in the `helpdock.app_password` session setting, which
-- `runMigrations` sets with a bound parameter. It is read inside a DO block so
-- that `log_statement` records the block and not the CREATE ROLE it builds. An
-- existing role is left exactly as it is, password included.
DO $$
DECLARE
  app_password text := current_setting('helpdock.app_password', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'helpdock_app') THEN
    IF app_password IS NULL OR app_password = '' THEN
      RAISE EXCEPTION 'The helpdock_app role does not exist and helpdock.app_password is not set. Pass appRolePassword to runMigrations, or create the role by hand (DOMAIN-RULES 1.5).';
    END IF;

    EXECUTE format(
      'CREATE ROLE helpdock_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD %L',
      app_password
    );
  END IF;
END
$$;--> statement-breakpoint

-- Data, never schema: no CREATE on the schema, nothing in the `drizzle` schema
-- that holds the migration log, and no ownership of anything.
GRANT USAGE ON SCHEMA public TO helpdock_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO helpdock_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO helpdock_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpdock_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO helpdock_app;--> statement-breakpoint

-- A role that can create a table owns it, and an owner is exempt from policies
-- that are not FORCEd. PostgreSQL 15 and later already withhold CREATE on the
-- public schema from PUBLIC; this states it, and only where the migration owner
-- is entitled to.
DO $$
BEGIN
  IF pg_catalog.pg_has_role(
       current_user,
       (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = 'public'),
       'MEMBER'
     ) THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  END IF;
END
$$;--> statement-breakpoint

-- Ticket numbers come from one sequence per brand, created with the brand
-- (ARCHITECTURE §5). Creating it is DDL, which the runtime role must not have,
-- so an AFTER INSERT trigger does it with the owner's rights. The sequence name
-- is built from a uuid and quoted as an identifier, so the row cannot name it.
CREATE FUNCTION public.helpdock_create_brand_ticket_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS public.%I AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE',
    'brand_ticket_seq_' || replace(NEW.id::text, '-', '')
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- A SECURITY DEFINER function is executable by PUBLIC unless that is taken
-- away. The trigger does not need it: PostgreSQL checks EXECUTE when the
-- trigger is created, not when it fires.
REVOKE EXECUTE ON FUNCTION public.helpdock_create_brand_ticket_sequence() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER brands_create_ticket_sequence
AFTER INSERT ON public.brands
FOR EACH ROW
EXECUTE FUNCTION public.helpdock_create_brand_ticket_sequence();
