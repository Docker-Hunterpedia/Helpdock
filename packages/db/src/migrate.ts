import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { APP_ROLE_NAME } from './roles.js';

/**
 * Migrations run at api boot as the owner role (ARCHITECTURE §5, DOMAIN-RULES
 * §1.5). Several replicas start at once, so the whole run is wrapped in a
 * Postgres advisory lock: the first replica migrates, the others wait and then
 * find nothing to do.
 */

/** ASCII "HDMG", Helpdock migrations. Any fixed number works; all replicas use this one. */
const MIGRATION_LOCK_ID = 0x48444d47;

/** Session setting the role migration reads the runtime role's password from. */
const APP_PASSWORD_SETTING = 'helpdock.app_password';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));
const JOURNAL_PATH = fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url));

interface JournalEntry {
  readonly when: number;
  readonly tag: string;
}

interface Journal {
  readonly entries: readonly JournalEntry[];
}

/**
 * The migrations that were not applied before the run and are applied after it.
 * Drizzle records a migration by the millisecond of its folder name, which is
 * what the journal calls `when`.
 */
export const newlyAppliedTags = (
  journal: Journal,
  before: ReadonlySet<number>,
  after: ReadonlySet<number>,
): readonly string[] =>
  journal.entries
    .filter((entry) => !before.has(entry.when) && after.has(entry.when))
    .map((entry) => entry.tag);

/**
 * The runtime role's password, taken from `DATABASE_URL` so that one secret
 * describes one role. The migration provisions `helpdock_app` with it on a
 * fresh database and leaves an existing role alone.
 */
export const appRolePasswordFromUrl = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (user !== APP_ROLE_NAME) {
    throw new Error(
      `DATABASE_URL must connect as ${APP_ROLE_NAME}, the runtime role of DOMAIN-RULES §1.5, not as ${user || 'an unnamed role'}`,
    );
  }
  if (password === '') {
    throw new Error(`DATABASE_URL must carry the password of the ${APP_ROLE_NAME} role`);
  }

  return password;
};

export interface RunMigrationsOptions {
  /** `DATABASE_MIGRATION_URL`: the owner role, which is the only one with DDL rights. */
  readonly migrationUrl: string;
  /**
   * Password to provision the runtime role with, from
   * {@link appRolePasswordFromUrl}. Omit it when the role already exists and is
   * managed outside Helpdock.
   */
  readonly appRolePassword?: string;
  /** Defaults to one line on stdout. The api passes its logger once it has one. */
  readonly log?: (message: string) => void;
}

export interface MigrationResult {
  /** Migrations this call applied, in order. Empty when the database was up to date. */
  readonly applied: readonly string[];
  /**
   * Migrations the database has recorded once this call finished — how far the
   * schema has been brought, not how far this boot brought it.
   *
   * It is returned rather than left to be queried later because the migration
   * log lives in the `drizzle` schema, which the runtime role deliberately
   * cannot read (see `0001_app_role_and_ticket_sequences.sql`). The owner
   * connection that runs the migrations is the only one that may count them, so
   * it counts them while it is here (ARCHITECTURE §14, the System page).
   */
  readonly total: number;
}

type Client = ReturnType<typeof postgres>;

const appliedMillis = async (client: Client): Promise<ReadonlySet<number>> => {
  const [table] = await client<{ oid: string | null }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations')::text AS oid
  `;
  if (table?.oid == null) {
    return new Set();
  }

  // `created_at` is a bigint; casting it in SQL avoids depending on how the
  // driver decides to represent one.
  const rows = await client<{ created_at: string }[]>`
    SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations
  `;
  return new Set(rows.map((row) => Number(row.created_at)));
};

const readJournal = async (): Promise<Journal> =>
  JSON.parse(await readFile(JOURNAL_PATH, 'utf8')) as Journal;

const applyMigrations = async (client: Client): Promise<MigrationResult> => {
  const before = await appliedMillis(client);
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  const after = await appliedMillis(client);

  return {
    applied: newlyAppliedTags(await readJournal(), before, after),
    total: after.size,
  };
};

/**
 * Applies every pending migration and returns the ones it applied. Safe to call
 * from several replicas at once: the advisory lock serialises them, and a
 * replica that loses the race applies nothing.
 */
export const runMigrations = async ({
  migrationUrl,
  appRolePassword,
  log = (message) => process.stdout.write(`${message}\n`),
}: RunMigrationsOptions): Promise<MigrationResult> => {
  // One connection: the advisory lock and the password setting are session
  // state, and they have to be the same session the migrations run in.
  const client = postgres(migrationUrl, { max: 1, onnotice: () => {} });

  try {
    // Bound as a parameter, so the password never appears in the statement text.
    await client`SELECT set_config(${APP_PASSWORD_SETTING}, ${appRolePassword ?? ''}, false)`;
    await client`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID}::bigint)`;

    try {
      const result = await applyMigrations(client);

      log(
        result.applied.length === 0
          ? 'Database is up to date; no migrations applied.'
          : `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}.`,
      );
      return result;
    } finally {
      await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID}::bigint)`;
      await client`SELECT set_config(${APP_PASSWORD_SETTING}, '', false)`;
    }
  } finally {
    await client.end();
  }
};
