import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  '0055_import_source_details',
  '0056_imported_csat',
  '0057_import_worker_claims',
  '0058_imported_knowledge_metadata',
  '0059_imported_activity',
  '0060_imported_participant_source',
  '0061_imported_csat_details',
  '0062_imported_section_ancestry',
  '0063_import_record_load_receipts',
  '0064_import_source_accounts',
  '0065_import_message_identity',
  '0066_import_dry_run_identity',
  '0067_import_csat_source_accounts',
  '0068_import_source_files',
  '0069_import_staging_retention',
  '0070_imported_sla_activation',
  '0071_imported_sla_candidates',
  '0072_imported_ticket_native_search',
  '0073_ticket_activity_history_cursor',
  '0074_imported_unscored_satisfaction',
  '0075_import_ticket_inventory',
  '0076_imported_message_provenance',
  '0077_imported_article_assets',
  '0078_imported_article_published_copy',
  '0079_imported_article_translation_lookup',
  '0080_import_attachment_dry_run_media',
  '0081_imported_article_embedding_deferral',
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

  it.each(['known', 'unknown', 'ambiguous'] as const)(
    'migrates %s satisfaction account ownership without guessing',
    async (ownership) => {
      const url = await migrated(`csat_upgrade_${ownership}`);
      const owner = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await owner`ALTER TABLE csat_responses DROP COLUMN import_source_account_key CASCADE`;
        await owner`CREATE UNIQUE INDEX csat_responses_import_key ON csat_responses(brand_id, imported_source, imported_external_id) WHERE imported_external_id IS NOT NULL`;
        const [brand] =
          await owner`INSERT INTO brands(id,name,prefix) VALUES(gen_random_uuid(),'CSAT upgrade','CSA') RETURNING id`;
        const [department] =
          await owner`INSERT INTO departments(id,brand_id,name) VALUES(gen_random_uuid(),${brand?.id},'Support') RETURNING id`;
        const [status] =
          await owner`INSERT INTO ticket_statuses(id,brand_id,name,system_state,color) VALUES(gen_random_uuid(),${brand?.id},'Open','open','info') RETURNING id`;
        const [ticket] =
          await owner`INSERT INTO tickets(id,brand_id,department_id,number,prefix,subject,status_id,channel)
        VALUES(gen_random_uuid(),${brand?.id},${department?.id},1,'CSA','History',${status?.id},'email') RETURNING id`;
        const [answer] =
          await owner`INSERT INTO csat_responses(id,brand_id,department_id,ticket_id,imported_source,imported_external_id,token_hash,expires_at,rating,rated_at,rated_via)
        VALUES(gen_random_uuid(),${brand?.id},${department?.id},${ticket?.id},'zendesk','rating-1','synthetic-migration-hash','1970-01-01',5,'2019-01-01','import') RETURNING id`;
        if (ownership !== 'unknown')
          await owner`INSERT INTO import_external_ids(brand_id,source,source_account_key,entity,external_id,helpdock_id,payload_hash)
        VALUES(${brand?.id},'zendesk',${'a'.repeat(64)},'csat','rating-1',${answer?.id},${'1'.repeat(64)})`;
        if (ownership === 'ambiguous')
          await owner`INSERT INTO import_external_ids(brand_id,source,source_account_key,entity,external_id,helpdock_id,payload_hash)
        VALUES(${brand?.id},'zendesk',${'b'.repeat(64)},'csat','rating-1',${answer?.id},${'1'.repeat(64)})`;
        const migration = readFileSync(
          new URL('../drizzle/0067_import_csat_source_accounts.sql', import.meta.url),
          'utf8',
        );
        const applied = owner.begin(async (tx) => {
          for (const statement of migration.split('--> statement-breakpoint'))
            if (statement.trim()) await tx.unsafe(statement);
        });
        if (ownership === 'ambiguous') {
          await expect(applied).rejects.toThrow(
            'Cannot assign imported satisfaction to multiple source accounts',
          );
          expect(
            await owner`SELECT column_name FROM information_schema.columns WHERE table_name='csat_responses' AND column_name='import_source_account_key'`,
          ).toHaveLength(0);
        } else {
          await applied;
          expect(
            await owner`SELECT import_source_account_key AS account FROM csat_responses WHERE id=${answer?.id}`,
          ).toMatchObject([{ account: (ownership === 'known' ? 'a' : '0').repeat(64) }]);
        }
      } finally {
        await owner.end();
      }
    },
  );

  it.each(['valid', 'collision'] as const)(
    'backfills satisfaction history without resending or rewriting answers: %s',
    async (kind) => {
      const url = await migrated(`csat_history_${kind}`);
      const owner = postgres(url, { max: 1, onnotice: () => {} });
      try {
        const [brand] =
          await owner`INSERT INTO brands(id,name,prefix) VALUES(gen_random_uuid(),'Historical answers','CSH') RETURNING id`;
        const [department] =
          await owner`INSERT INTO departments(id,brand_id,name) VALUES(gen_random_uuid(),${brand?.id},'Support') RETURNING id`;
        const [status] =
          await owner`INSERT INTO ticket_statuses(id,brand_id,name,system_state,color) VALUES(gen_random_uuid(),${brand?.id},'Open','open','info') RETURNING id`;
        const [ticket] =
          await owner`INSERT INTO tickets(id,brand_id,department_id,number,prefix,subject,status_id,channel)
        VALUES(gen_random_uuid(),${brand?.id},${department?.id},1,'CSH','Old answer',${status?.id},'email') RETURNING id`;
        const [answer] =
          await owner`INSERT INTO csat_responses(id,brand_id,department_id,ticket_id,imported_source,imported_external_id,token_hash,expires_at,rating,rated_at,rated_via,imported_details)
        VALUES(gen_random_uuid(),${brand?.id},${department?.id},${ticket?.id},'freshdesk','legacy:1','synthetic-history-hash','1970-01-01',5,'2019-01-01','import',${owner.json({ originalAnswers: [{ question_id: 'Q1', question_text: 'Original question', value: 103 }] })}) RETURNING id`;
        await owner`INSERT INTO csat_responses(id,brand_id,department_id,ticket_id,closed_at,token_hash,expires_at)
        VALUES(gen_random_uuid(),${brand?.id},${department?.id},${ticket?.id},'2026-10-17','synthetic-native-hash','2026-11-17')`;
        const before =
          await owner`SELECT id,xmin::text AS revision FROM csat_responses WHERE ticket_id=${ticket?.id} ORDER BY id`;
        if (kind === 'collision')
          await owner`INSERT INTO ticket_activity(id,brand_id,department_id,ticket_id,actor_type,actor_id,action,via)
        VALUES(${answer?.id},${brand?.id},${department?.id},${ticket?.id},'system','native','ticket.created','system')`;
        const migration = readFileSync(
          new URL('../drizzle/0074_imported_unscored_satisfaction.sql', import.meta.url),
          'utf8',
        );
        const apply = () =>
          owner.begin(async (tx) => {
            for (const statement of migration.split('--> statement-breakpoint'))
              if (statement.trim()) await tx.unsafe(statement);
          });
        if (kind === 'collision')
          await expect(apply()).rejects.toThrow(
            'Imported satisfaction history ID belongs to another activity',
          );
        else {
          await apply();
          expect(
            await owner`SELECT id,action,"to",created_at FROM ticket_activity WHERE ticket_id=${ticket?.id}`,
          ).toMatchObject([
            {
              id: answer?.id,
              action: 'ticket.imported.event',
              to: {
                csat: { rating: 5, link: null },
                sourceEvent: {
                  action: 'csat.response',
                  details: { originalAnswers: [{ value: 103 }] },
                },
              },
              created_at: new Date('2019-01-01T00:00:00Z'),
            },
          ]);
          const events =
            await owner`SELECT id,xmin::text AS revision FROM ticket_activity WHERE ticket_id=${ticket?.id}`;
          await apply();
          expect(
            await owner`SELECT id,xmin::text AS revision FROM ticket_activity WHERE ticket_id=${ticket?.id}`,
          ).toEqual(events);
          expect(
            await owner`SELECT count(*)::int AS count FROM outbox WHERE brand_id=${brand?.id}`,
          ).toMatchObject([{ count: 0 }]);
        }
        expect(
          await owner`SELECT id,xmin::text AS revision FROM csat_responses WHERE ticket_id=${ticket?.id} ORDER BY id`,
        ).toEqual(before);
      } finally {
        await owner.end();
      }
    },
  );

  it('defers existing imported article languages without changing staff publications or another brand', async () => {
    const url = await migrated('import_embedding_deferral');
    const owner = postgres(url, { max: 1, onnotice: () => {} });
    const brand = uuidv7(),
      otherBrand = uuidv7(),
      publisher = uuidv7();
    const category = uuidv7(),
      section = uuidv7(),
      importedArticle = uuidv7(),
      liveArticle = uuidv7();
    try {
      await owner`ALTER TABLE hc_article_versions DROP COLUMN import_embedding_deferred`;
      await owner`INSERT INTO brands(id,name,prefix) VALUES (${brand},'Historical','MIG'),(${otherBrand},'Other','OTH')`;
      await owner`INSERT INTO users(id,email,name) VALUES (${publisher},'publisher@example.test','Publisher')`;
      await owner`INSERT INTO hc_categories(id,brand_id,slug) VALUES (${category},${brand},'category')`;
      await owner`INSERT INTO hc_sections(id,brand_id,category_id,slug) VALUES (${section},${brand},${category},'section')`;
      await owner`INSERT INTO hc_articles(id,brand_id,section_id,slug) VALUES
        (${importedArticle},${brand},${section},'imported'),(${liveArticle},${brand},${section},'live')`;
      await owner`INSERT INTO hc_article_versions(id,brand_id,article_id,locale,title,status,published_by) VALUES
        (${uuidv7()},${brand},${importedArticle},'en','Original English','published',NULL),
        (${uuidv7()},${brand},${importedArticle},'ar','Staff publication','published',${publisher}),
        (${uuidv7()},${brand},${liveArticle},'en','Live article','published',NULL)`;
      await owner`INSERT INTO import_external_ids(brand_id,source,entity,external_id,helpdock_id,payload_hash) VALUES
        (${brand},'zendesk','article','native',${importedArticle},${'a'.repeat(64)}),
        (${otherBrand},'zendesk','article','foreign-pointer',${liveArticle},${'b'.repeat(64)})`;
      const migration = readFileSync(
        new URL('../drizzle/0081_imported_article_embedding_deferral.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint'))
        if (statement.trim()) await owner.unsafe(statement);
      expect(
        await owner`SELECT title,import_embedding_deferred FROM hc_article_versions ORDER BY title`,
      ).toEqual([
        { title: 'Live article', import_embedding_deferred: false },
        { title: 'Original English', import_embedding_deferred: true },
        { title: 'Staff publication', import_embedding_deferred: false },
      ]);
    } finally {
      await owner.end();
    }
  });

  it('backfills imported message and copy provenance while retaining live RFC uniqueness', async () => {
    const url = await migrated('import_message_upgrade');
    const owner = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await owner`ALTER TABLE ticket_messages DROP COLUMN import_source_account_key CASCADE`;
      await owner`DROP INDEX ticket_messages_reference_idx`;
      await owner`CREATE UNIQUE INDEX ticket_messages_external_key ON ticket_messages(brand_id, channel, external_message_id) WHERE external_message_id IS NOT NULL`;
      const [brand] =
        await owner`INSERT INTO brands(id, name, prefix) VALUES (gen_random_uuid(), 'Header upgrade', 'REF') RETURNING id`;
      const [department] =
        await owner`INSERT INTO departments(id, brand_id, name) VALUES (gen_random_uuid(), ${brand?.id}, 'Support') RETURNING id`;
      const [status] =
        await owner`INSERT INTO ticket_statuses(id, brand_id, name, system_state, color) VALUES (gen_random_uuid(), ${brand?.id}, 'Open', 'open', 'info') RETURNING id`;
      const [ticket] =
        await owner`INSERT INTO tickets(id, brand_id, department_id, number, prefix, subject, status_id, channel)
        VALUES (gen_random_uuid(), ${brand?.id}, ${department?.id}, 1, 'REF', 'Historical mail', ${status?.id}, 'email') RETURNING id`;
      const [message] =
        await owner`INSERT INTO ticket_messages(id, brand_id, department_id, ticket_id, seq, kind, author_type, body_html, body_text, channel, external_message_id)
        VALUES (gen_random_uuid(), ${brand?.id}, ${department?.id}, ${ticket?.id}, 1, 'public', 'system', '<p>History</p>', 'History', 'email', 'original@vendor') RETURNING id`;
      const [copy] =
        await owner`INSERT INTO ticket_messages(id, brand_id, department_id, ticket_id, seq, kind, author_type, body_html, body_text, channel, copied_from_message_id)
        VALUES (gen_random_uuid(), ${brand?.id}, ${department?.id}, ${ticket?.id}, 2, 'public', 'system', '<p>History</p>', 'History', 'email', ${message?.id}) RETURNING id`;
      await owner`INSERT INTO import_external_ids(brand_id, source, source_account_key, entity, external_id, helpdock_id, payload_hash)
        VALUES (${brand?.id}, 'zendesk', ${'a'.repeat(64)}, 'message', 'native-root', ${message?.id}, ${'b'.repeat(64)})`;
      const migration = readFileSync(
        new URL('../drizzle/0065_import_message_identity.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await owner.unsafe(statement);
      }
      const historical =
        await owner`SELECT id, external_message_id, import_source_account_key FROM ticket_messages WHERE id IN (${message?.id}, ${copy?.id}) ORDER BY seq`;
      expect(historical).toEqual([
        {
          id: message?.id,
          external_message_id: 'original@vendor',
          import_source_account_key: 'a'.repeat(64),
        },
        { id: copy?.id, external_message_id: null, import_source_account_key: 'a'.repeat(64) },
      ]);
      await owner`INSERT INTO ticket_messages(id, brand_id, department_id, ticket_id, seq, kind, author_type, body_html, body_text, channel, external_message_id)
        VALUES (gen_random_uuid(), ${brand?.id}, ${department?.id}, ${ticket?.id}, 3, 'public', 'system', '<p>Live</p>', 'Live', 'email', 'original@vendor')`;
      await expect(owner`INSERT INTO ticket_messages(id, brand_id, department_id, ticket_id, seq, kind, author_type, body_html, body_text, channel, external_message_id)
        VALUES (gen_random_uuid(), ${brand?.id}, ${department?.id}, ${ticket?.id}, 4, 'public', 'system', '<p>Duplicate</p>', 'Duplicate', 'email', 'original@vendor')`).rejects.toMatchObject(
        { code: '23505' },
      );
    } finally {
      await owner.end();
    }
  });

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
