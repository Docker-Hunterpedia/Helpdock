-- Runs once, on an empty data directory, as POSTGRES_USER against POSTGRES_DB.
-- The container's own entrypoint has already created both from the POSTGRES_*
-- variables, so the owner role and the database exist by the time this runs.
--
-- What is left is the runtime role. `packages/db/drizzle/0001_…` creates
-- `helpdock_app` too, if it does not exist, with the password from
-- DATABASE_URL, and leaves an existing role exactly as it is. This file creates
-- it first so that DATABASE_URL works from the very first connection — before
-- any migration has run, and for an operator who inspects the database by hand.
--
-- Because the migration leaves an existing role alone, HELPDOCK_APP_PASSWORD
-- and the password inside DATABASE_URL have to be the same string. They are
-- documented together in `.env.example`.
--
-- Keep the attributes below identical to that migration: NOSUPERUSER,
-- NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, LOGIN. `assertRuntimeRoleIsSafe`
-- refuses to serve on a connection that can bypass row-level security
-- (DOMAIN-RULES §1.5), so a role created with more than this stops the api at
-- boot rather than quietly widening what a request can read.

\set ON_ERROR_STOP on

-- psql 14+ reads the environment with \getenv; the container passes
-- HELPDOCK_APP_PASSWORD through from Compose. psql expands a variable into the
-- statement text rather than binding it, so on a server started with
-- `log_statement = all` the password would reach the server log. That is not
-- the default and this file runs exactly once, on an empty data directory;
-- `runMigrations` binds the value properly for every later run.
\set app_password ''
\getenv app_password HELPDOCK_APP_PASSWORD

SELECT set_config('helpdock.init_app_password', :'app_password', false);

DO $$
DECLARE
  app_password text := current_setting('helpdock.init_app_password', true);
BEGIN
  IF app_password IS NULL OR app_password = '' THEN
    RAISE EXCEPTION 'HELPDOCK_APP_PASSWORD is empty. Set it in .env to the same password DATABASE_URL carries.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'helpdock_app') THEN
    -- Built with format(%L) so the password is quoted rather than concatenated,
    -- and inside a DO block so `log_statement` records the block and not the
    -- CREATE ROLE it builds.
    EXECUTE format(
      'CREATE ROLE helpdock_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD %L',
      app_password
    );
  END IF;
END
$$;

-- Connecting is all it may do until the migrations grant it DML on the tables
-- they create (`packages/db/drizzle/0001_app_role_and_ticket_sequences.sql`).
GRANT CONNECT ON DATABASE :"DBNAME" TO helpdock_app;
