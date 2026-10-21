import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
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
  '0016_merge_and_split',
  '0017_spam_and_block_list',
  '0018_time_tracking_and_csat',
  '0019_contact_identity_and_participants',
  '0020_data_retention',
  '0021_ticket_list_indexes',
  '0022_views',
  '0023_ticket_search_tokens',
  '0024_email_outbound',
  '0025_email_inbound',
  '0026_sla_engine',
  '0027_workflow_rules',
  '0028_macros_and_audit_context',
  '0029_notifications',
  '0030_brand_domain_verification',
  '0031_widget',
  '0032_web_form',
  '0033_help_center',
  '0034_help_center_search',
  '0035_help_center_site',
  '0036_telegram',
  '0037_report_rollups',
  '0038_ai_and_knowledge',
  '0039_api_keys_and_webhooks',
  '0040_telegram_chat_identity',
  '0041_knowledge_ingest',
  '0042_ai_assistant_modes',
  '0043_csat_delivery',
  '0044_report_daily_assignee',
  '0045_auto_reply_handoff',
  '0046_ai_assist_and_transcripts',
  '0047_drop_ai_pii_redaction_toggle',
  '0048_telegram_language_prompt',
  '0049_api_key_expiry',
  '0050_meta_channels',
  '0051_meta_profile_checked',
  '0052_meta_deliveries_platform_ids',
  '0053_sso',
  '0054_imports',
  '0055_contact_ticket_count_skips_deleted',
  '0056_oauth_identities',
  '0057_contact_ticket_count_skips_spam',
  '0058_webauthn_credentials',
  '0059_oauth_identity_use',
  '0060_notification_pacing',
  '0061_ticket_sla_next_due',
  '0062_webhook_note_opt_in',
  '0063_single_key_shortcuts',
  '0064_ticket_snooze',
  '0065_oauth_microsoft_provider',
  '0066_bulk_edit',
  '0067_passkey_user_verified',
  '0068_idle_away_minutes',
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
    expect(second.recorded).toEqual([...MIGRATION_TAGS].reverse());
  });

  it.each([52, 53])(
    'upgrades an existing install at migration %s in one transaction without losing live history',
    async (prefix) => {
      const url = await freshDatabase(`pre_import_upgrade_${prefix}`);
      const folder = await mkdtemp(join(tmpdir(), 'helpdock-upgrade-'));
      const owner = postgres(url, { max: 1, onnotice: () => {} });
      try {
        const journal = JSON.parse(
          readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
        );
        journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= prefix);
        await mkdir(join(folder, 'meta'));
        await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
        for (const entry of journal.entries)
          await cp(
            new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
            join(folder, `${entry.tag}.sql`),
          );
        await owner`SELECT set_config('helpdock.app_password', ${APP_ROLE_PASSWORD}, false)`;
        await migrate(drizzle(owner), { migrationsFolder: folder });
        const [brand] =
          await owner`INSERT INTO brands(id,name,prefix) VALUES(gen_random_uuid(),'Existing install','OLD') RETURNING id`;
        const [department] =
          await owner`INSERT INTO departments(id,brand_id,name) VALUES(gen_random_uuid(),${brand?.id},'Support') RETURNING id`;
        const [status] =
          await owner`INSERT INTO ticket_statuses(id,brand_id,name,system_state,color) VALUES(gen_random_uuid(),${brand?.id},'Closed','closed','info') RETURNING id`;
        const [ticket] =
          await owner`INSERT INTO tickets(id,brand_id,department_id,number,prefix,subject,status_id,channel,closed_at)
        VALUES(gen_random_uuid(),${brand?.id},${department?.id},1,'OLD','Existing history',${status?.id},'email','2025-01-01') RETURNING id`;
        await owner`INSERT INTO csat_responses(id,brand_id,department_id,ticket_id,closed_at,token_hash,expires_at,rating,rated_at,rated_via)
        VALUES(gen_random_uuid(),${brand?.id},${department?.id},${ticket?.id},'2025-01-01','existing-answer','2025-02-01',5,'2025-01-02','link')`;
        const before =
          await owner`SELECT id,rating,rated_at,rated_via,token_hash FROM csat_responses`;
        const result = await runMigrations({
          migrationUrl: url,
          appRolePassword: APP_ROLE_PASSWORD,
          log: () => {},
        });
        expect(result.applied).toEqual(
          MIGRATION_TAGS.filter((tag) => Number(tag.slice(0, 4)) > prefix),
        );
        expect(
          await owner`SELECT id,rating,rated_at,rated_via,token_hash FROM csat_responses`,
        ).toEqual(before);
        expect(await owner`SELECT subject FROM tickets WHERE id=${ticket?.id}`).toEqual([
          { subject: 'Existing history' },
        ]);
        expect(await owner`SELECT count(*)::int AS count FROM outbox`).toEqual([{ count: 0 }]);
        expect((await runMigrations({ migrationUrl: url, log: () => {} })).applied).toEqual([]);
      } finally {
        await owner.end();
        await rm(folder, { recursive: true, force: true });
      }
    },
  );

  it('enforces one claimed import per brand and requires valid claim and pause metadata', async () => {
    const url = await migrated('import_claims');
    const owner = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const [person] =
        await owner`INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), 'claim-test@example.com', 'Importer') RETURNING id`;
      const [brand] =
        await owner`INSERT INTO brands (id, name, prefix) VALUES (gen_random_uuid(), 'Claims', 'CL') RETURNING id`;
      const [claimed] =
        await owner`INSERT INTO import_runs (id, brand_id, source, started_by, status, claim_token, claimed_at)
        VALUES (gen_random_uuid(), ${brand?.id}, 'file', ${person?.id}, 'loading', gen_random_uuid(), now()) RETURNING id`;
      await expect(owner`INSERT INTO import_runs (id, brand_id, source, started_by, status, claim_token, claimed_at)
        VALUES (gen_random_uuid(), ${brand?.id}, 'file', ${person?.id}, 'extracting', gen_random_uuid(), now())`).rejects.toMatchObject(
        { code: '23505' },
      );
      await expect(
        owner`UPDATE import_runs SET claimed_at = NULL WHERE id = ${claimed?.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner`UPDATE import_runs SET status = 'paused', claim_token = NULL, claimed_at = NULL WHERE id = ${claimed?.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await owner`UPDATE import_runs SET status = 'paused', paused_from = 'loading', claim_token = NULL, claimed_at = NULL WHERE id = ${claimed?.id}`;
      await expect(
        owner`UPDATE import_runs SET paused_from = 'ready' WHERE id = ${claimed?.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await owner`UPDATE import_runs SET status = 'loading', paused_from = NULL, claim_token = gen_random_uuid(), claimed_at = now() WHERE id = ${claimed?.id}`;
    } finally {
      await owner.end();
    }
  });

  it('binds import children to their own brand and refuses credentials in terminal runs', async () => {
    const url = await migrated('import_constraints');
    const owner = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const [person] =
        await owner`INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), 'import-test@example.com', 'Importer') RETURNING id`;
      const tenants = await owner`INSERT INTO brands (id, name, prefix) VALUES
        (gen_random_uuid(), 'Import A', 'IA'),
        (gen_random_uuid(), 'Import B', 'IB') RETURNING id`;
      const [run] =
        await owner`INSERT INTO import_runs (id, brand_id, source, started_by, credentials_encrypted)
        VALUES (gen_random_uuid(), ${tenants[0]?.id}, 'file', ${person?.id}, 'encrypted-fixture') RETURNING id`;
      await expect(owner`INSERT INTO import_records (id, brand_id, run_id, entity, external_id, payload, payload_hash)
        VALUES (gen_random_uuid(), ${tenants[1]?.id}, ${run?.id}, 'ticket', '1', '{}', ${'a'.repeat(64)})`).rejects.toMatchObject(
        { code: '23503' },
      );
      await expect(
        owner`UPDATE import_runs SET status = 'completed' WHERE id = ${run?.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await owner`UPDATE import_runs SET status = 'completed', credentials_encrypted = NULL WHERE id = ${run?.id}`;
      const [completed] =
        await owner`SELECT status, credentials_encrypted FROM import_runs WHERE id = ${run?.id}`;
      expect(completed).toEqual({ status: 'completed', credentials_encrypted: null });
      await owner`INSERT INTO import_runs (id, brand_id, source, mode, parent_run_id, started_by)
        VALUES (gen_random_uuid(), ${tenants[0]?.id}, 'file', 'delta', ${run?.id}, ${person?.id})`;
      // Brand purge deletes in batches; a parent's dependent deltas must not block its batch.
      await owner`DELETE FROM import_runs WHERE id = ${run?.id}`;
      expect(
        await owner`SELECT id FROM import_runs WHERE brand_id = ${tenants[0]?.id}`,
      ).toHaveLength(0);
      const origins =
        await owner`SELECT enumlabel FROM pg_enum JOIN pg_type ON enumtypid = pg_type.oid WHERE typname = 'csat_answer_channel'`;
      expect(origins.map((entry) => entry.enumlabel)).toContain('import');
    } finally {
      await owner.end();
    }
  });

  it('keeps idle_away_minutes null or within 10 to 240 on a department', async () => {
    const url = await migrated('idle_away_minutes');
    const owner = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const [brand] =
        await owner`INSERT INTO brands (id, name, prefix) VALUES (gen_random_uuid(), 'Idle', 'ID') RETURNING id`;
      const insert = (name: string, minutes: number | null) =>
        owner`INSERT INTO departments (id, brand_id, name, idle_away_minutes)
          VALUES (gen_random_uuid(), ${brand?.id}, ${name}, ${minutes})`;
      await insert('off', null);
      await insert('lowest', 10);
      await insert('highest', 240);
      await expect(insert('too-low', 9)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('too-high', 241)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await owner.end();
    }
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
