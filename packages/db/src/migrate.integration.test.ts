import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { APP_ROLE_NAME, assertRuntimeRoleIsSafe } from './roles.js';
import { brands, brandTicketSequenceName } from './schema/index.js';
import { uuidv7 } from './uuid.js';

// pgvector on PostgreSQL 17: the image ARCHITECTURE §17 runs in production, so
// the knowledge milestones can enable the extension without changing this.
const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';
const MIGRATION_TAGS = [
  '0000_core_tables',
  '0001_app_role_and_ticket_sequences',
  '0002_tenant_rls_policies',
  '0003_outbox_notify_relay',
  '0004_brand_domains',
  '0005_departments',
  '0006_contacts_and_accounts',
  '0007_tickets',
  '0008_ticket_department_sync',
  '0009_departments_teams_and_brand_settings',
  '0012_tickets_soft_delete_and_status_reporting',
  '0013_attachments',
  '0014_tags_custom_fields_and_templates',
  '0015_assignment',
  '0017_spam_and_block_list',
  '0019_contact_identity_and_participants',
  '0021_ticket_list_indexes',
];

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  // Written straight to stderr: Vitest drops console output from a file whose
  // suites are all skipped, and an operator who runs the integration project
  // without Docker deserves to be told why nothing ran.
  process.stderr.write(
    'Skipping the Postgres migration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('migrations', () => {
  let container: StartedPostgreSqlContainer;
  let admin: postgres.Sql;
  const handles: DbHandle[] = [];

  const urlFor = (database: string, user: string, password: string): string =>
    `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${database}`;

  const ownerUrlFor = (database: string): string =>
    urlFor(database, container.getUsername(), container.getPassword());

  /** One database per test, so a run never sees what another run migrated. */
  const freshDatabase = async (name: string): Promise<string> => {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    return ownerUrlFor(name);
  };

  const migrated = async (name: string): Promise<string> => {
    const url = await freshDatabase(name);
    await runMigrations({ migrationUrl: url, appRolePassword: APP_ROLE_PASSWORD, log: () => {} });
    return url;
  };

  const open = (url: string): DbHandle => {
    const handle = createDb({ url, max: 2 });
    handles.push(handle);
    return handle;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await Promise.all(handles.map((handle) => handle.close()));
    await admin?.end();
    await container?.stop();
  });

  it('applies every migration on a fresh database, and nothing on the next run', async () => {
    const url = await freshDatabase('run_twice');

    const first = await runMigrations({
      migrationUrl: url,
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    const second = await runMigrations({
      migrationUrl: url,
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });

    expect(first.applied).toEqual(MIGRATION_TAGS);
    expect(second.applied).toEqual([]);

    // `total` is how far the schema has been brought, so the second run reports
    // the same number as the first even though it applied nothing. The System
    // page reads it from boot, because the runtime role may not read the log.
    expect(first.total).toBe(MIGRATION_TAGS.length);
    expect(second.total).toBe(MIGRATION_TAGS.length);
  });

  it('applies each migration once when two replicas start at the same time', async () => {
    const url = await freshDatabase('two_replicas');

    const [first, second] = await Promise.all([
      runMigrations({ migrationUrl: url, appRolePassword: APP_ROLE_PASSWORD, log: () => {} }),
      runMigrations({ migrationUrl: url, appRolePassword: APP_ROLE_PASSWORD, log: () => {} }),
    ]);

    // Both calls succeed, and between them each migration ran exactly once.
    expect([...first.applied, ...second.applied].sort()).toEqual(MIGRATION_TAGS);

    const owner = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await expect(owner`SELECT hash FROM drizzle.__drizzle_migrations`).resolves.toHaveLength(
        MIGRATION_TAGS.length,
      );
    } finally {
      await owner.end();
    }
  });

  it('reports what it applied without ever naming the password', async () => {
    const url = await freshDatabase('logging');
    const lines: string[] = [];

    await runMigrations({
      migrationUrl: url,
      appRolePassword: APP_ROLE_PASSWORD,
      log: (message) => lines.push(message),
    });

    expect(lines.join('\n')).toContain('0002_tenant_rls_policies');
    expect(lines.join('\n')).not.toContain(APP_ROLE_PASSWORD);
  });

  it('leaves a role that already exists alone', async () => {
    // Roles are cluster-wide, so this is the state every install but the first
    // one starts from.
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_NAME}') THEN
          CREATE ROLE ${APP_ROLE_NAME} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN
            PASSWORD '${APP_ROLE_PASSWORD}';
        END IF;
      END $$;
    `);
    const url = await freshDatabase('existing_role');

    await expect(runMigrations({ migrationUrl: url, log: () => {} })).resolves.toMatchObject({
      applied: MIGRATION_TAGS,
    });
    // The password it was created with still works, which is what "left alone" means.
    const app = open(urlFor('existing_role', APP_ROLE_NAME, APP_ROLE_PASSWORD));
    await expect(assertRuntimeRoleIsSafe(app.db)).resolves.toBeDefined();
  });

  it('provisions a runtime role that cannot escape row-level security', async () => {
    await migrated('runtime_role');

    const [role] = await admin<
      { rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]
    >`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      FROM pg_roles WHERE rolname = ${APP_ROLE_NAME}
    `;

    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it('lets the runtime role write rows but never change the schema', async () => {
    await migrated('runtime_grants');
    const app = open(urlFor('runtime_grants', APP_ROLE_NAME, APP_ROLE_PASSWORD));

    await expect(assertRuntimeRoleIsSafe(app.db)).resolves.toMatchObject({
      roleName: APP_ROLE_NAME,
      superuser: false,
      bypassRls: false,
      ownedTables: 0,
    });
    await expect(
      app.db.insert(brands).values({ name: 'Acme', prefix: 'ACME' }),
    ).resolves.toBeDefined();
    // Drizzle re-wraps a driver error, so the reason Postgres gave is the cause.
    const rejection = await app.db.execute('CREATE TABLE smuggled (id uuid PRIMARY KEY)').then(
      () => undefined,
      (error: unknown) => error as { cause?: { message?: string } },
    );
    expect(rejection?.cause?.message).toMatch(/permission denied/i);
  });

  it('refuses to serve traffic as the migration owner', async () => {
    const url = await migrated('owner_is_unsafe');

    await expect(assertRuntimeRoleIsSafe(open(url).db)).rejects.toThrow(/must not serve traffic/);
  });

  describe('the brand ticket sequence', () => {
    let app: DbHandle;

    beforeAll(async () => {
      await migrated('ticket_sequences');
      app = open(urlFor('ticket_sequences', APP_ROLE_NAME, APP_ROLE_PASSWORD));
    });

    it('exists as soon as the brand does, and counts from one', async () => {
      const brandId = uuidv7();
      await app.db.insert(brands).values({ id: brandId, name: 'Acme', prefix: 'ACME' });

      const sequence = brandTicketSequenceName(brandId);
      const first = await app.db.execute(`SELECT nextval('${sequence}')::int AS number`);
      const second = await app.db.execute(`SELECT nextval('${sequence}')::int AS number`);

      expect(first[0]).toEqual({ number: 1 });
      expect(second[0]).toEqual({ number: 2 });
    });

    it('gives each brand a counter of its own', async () => {
      const brandId = uuidv7();
      await app.db.insert(brands).values({ id: brandId, name: 'Globex', prefix: 'GLOBEX' });

      const number = await app.db.execute(
        `SELECT nextval('${brandTicketSequenceName(brandId)}')::int AS number`,
      );

      expect(number[0]).toEqual({ number: 1 });
    });
  });
});
