import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKeyring, decryptSecret, encryptSecret, type Keyring } from '@helpdock/config';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import {
  MASTER_KEY_ROTATED_ACTION,
  MasterKeyRotationError,
  rotateMasterKey,
} from './master-key-rotation.js';
import { runMigrations } from './migrate.js';
import { APP_ROLE_NAME } from './roles.js';
import {
  auditLog,
  brands,
  outbox,
  settings,
  users,
  webhooks,
  widgetSettings,
} from './schema/index.js';
import { INSTALL_SCOPE_BRAND_ID, withSystem, withTenant } from './tenant.js';
import { uuidv7 } from './uuid.js';

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the master key rotation tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const keyOf = (fill: number): string => Buffer.alloc(32, fill).toString('base64');
const OLD_KEY = keyOf(1);
const NEW_KEY = keyOf(2);
const STRANGER_KEY = keyOf(3);

const oldOnly = createKeyring({ APP_MASTER_KEY: OLD_KEY });
const rotating = createKeyring({ APP_MASTER_KEY: NEW_KEY, APP_MASTER_KEY_PREVIOUS: OLD_KEY });
const newOnly = createKeyring({ APP_MASTER_KEY: NEW_KEY });

const installContext = {
  brandIds: [INSTALL_SCOPE_BRAND_ID],
  departmentIds: 'all' as const,
  principalType: 'system' as const,
  principalId: 'test',
};

describe.skipIf(!hasDocker)('rotateMasterKey', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  const acme = uuidv7();
  const globex = uuidv7();
  const userId = uuidv7();

  /** Every place the test stored a secret, read back as it is now. */
  const stored = async (): Promise<Record<string, string>> => {
    const { db } = handle;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const [install] = await withTenant(db, installContext, (tx) =>
      tx.select().from(settings).where(eq(settings.key, 'smtp.password')),
    );
    const brandSecret = async (brandId: string) =>
      withSystem(db, brandId, async (tx) => {
        const [widget] = await tx.select().from(widgetSettings);
        const [webhook] = await tx.select().from(webhooks);
        const [pending] = await tx.select().from(outbox).where(sql`${outbox.publishedAt} is null`);
        return { widget, webhook, pending };
      });
    const a = await brandSecret(acme);
    const b = await brandSecret(globex);

    return {
      totp: user?.totpSecretEncrypted ?? '',
      installSetting: install?.value ?? '',
      acmeWidget: a.widget?.signingSecret ?? '',
      acmeWebhook: a.webhook?.secret ?? '',
      acmeOutbox: String(a.pending?.payload.urlEncrypted ?? ''),
      globexWebhook: b.webhook?.secret ?? '',
    };
  };

  const plaintexts = async (keyring: Keyring): Promise<Record<string, string>> =>
    Object.fromEntries(
      Object.entries(await stored()).map(([place, value]) => [
        place,
        decryptSecret(value, keyring),
      ]),
    );

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations({
      migrationUrl: container.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    handle = createDb({
      url: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`,
    });
  });

  afterAll(async () => {
    await handle?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    const { db } = handle;
    await db.delete(brands);
    await db.delete(users);
    await withTenant(db, installContext, (tx) => tx.delete(settings));

    await db.insert(brands).values([
      { id: acme, name: 'Acme', prefix: 'ACME' },
      { id: globex, name: 'Globex', prefix: 'GLX' },
    ]);
    await db.insert(users).values({
      id: userId,
      email: 'ada@example.test',
      name: 'Ada',
      totpSecretEncrypted: encryptSecret('totp-secret', oldOnly),
    });
    await withTenant(db, installContext, (tx) =>
      tx.insert(settings).values([
        {
          key: 'smtp.password',
          brandId: INSTALL_SCOPE_BRAND_ID,
          value: encryptSecret('"smtp-password"', oldOnly),
          updatedBy: 'test',
        },
        { key: 'smtp.port', brandId: INSTALL_SCOPE_BRAND_ID, value: '587', updatedBy: 'test' },
      ]),
    );
    await withSystem(db, acme, async (tx) => {
      await tx
        .insert(widgetSettings)
        .values({ brandId: acme, signingSecret: encryptSecret('widget-secret', oldOnly) });
      await tx.insert(webhooks).values({
        brandId: acme,
        url: 'https://hooks.example.test/a',
        secret: encryptSecret('acme-webhook', oldOnly),
      });
      await tx.insert(outbox).values([
        {
          brandId: acme,
          event: 'auth.email_requested',
          payload: { urlEncrypted: encryptSecret('https://sign-in.example.test', oldOnly) },
        },
        {
          brandId: acme,
          event: 'auth.email_requested',
          payload: { urlEncrypted: encryptSecret('https://already-sent.example.test', oldOnly) },
          publishedAt: new Date(),
        },
      ]);
    });
    await withSystem(db, globex, (tx) =>
      tx.insert(webhooks).values({
        brandId: globex,
        url: 'https://hooks.example.test/g',
        secret: encryptSecret('globex-webhook', oldOnly),
      }),
    );
  });

  it('re-encrypts every secret of every brand so the new key alone opens it', async () => {
    const before = await plaintexts(oldOnly);

    const report = await rotateMasterKey(handle.db, rotating);

    expect(report.rotated).toBe(6);
    expect(report.currentKeyId).toBe(newOnly.current.id);
    expect(report.previousKeyId).toBe(oldOnly.current.id);
    await expect(plaintexts(newOnly)).resolves.toEqual(before);
  });

  it('leaves settings that are not secrets, and outbox rows already published, alone', async () => {
    await rotateMasterKey(handle.db, rotating);

    const [port] = await withTenant(handle.db, installContext, (tx) =>
      tx.select().from(settings).where(eq(settings.key, 'smtp.port')),
    );
    const [published] = await withSystem(handle.db, acme, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.publishedAt} is not null`),
    );

    expect(port?.value).toBe('587');
    expect(decryptSecret(String(published?.payload.urlEncrypted), oldOnly)).toBe(
      'https://already-sent.example.test',
    );
  });

  it('changes nothing on a second run, and says so', async () => {
    await rotateMasterKey(handle.db, rotating);
    const after = await stored();

    const again = await rotateMasterKey(handle.db, newOnly);

    expect(again.rotated).toBe(0);
    expect(again.previousKeyId).toBeNull();
    await expect(stored()).resolves.toEqual(after);
  });

  it('records each run in the install audit log, with key ids and never a key', async () => {
    const runs = () =>
      withTenant(handle.db, installContext, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.brandId, INSTALL_SCOPE_BRAND_ID),
              eq(auditLog.action, MASTER_KEY_ROTATED_ACTION),
            ),
          )
          .orderBy(desc(auditLog.createdAt)),
      );
    const earlier = (await runs()).length;

    await rotateMasterKey(handle.db, rotating);

    const rows = await runs();
    expect(rows).toHaveLength(earlier + 1);
    expect(rows[0]?.meta).toEqual({
      currentKeyId: newOnly.current.id,
      previousKeyId: oldOnly.current.id,
      rotated: 6,
    });
    expect(JSON.stringify(rows[0])).not.toContain(NEW_KEY);
  });

  it('rolls everything back when one value opens with neither key', async () => {
    await withSystem(handle.db, globex, (tx) =>
      tx
        .update(webhooks)
        .set({
          secret: encryptSecret('lost', createKeyring({ APP_MASTER_KEY: STRANGER_KEY })),
        })
        .where(eq(webhooks.brandId, globex)),
    );
    const before = await stored();

    const failure = rotateMasterKey(handle.db, rotating);

    await expect(failure).rejects.toBeInstanceOf(MasterKeyRotationError);
    await expect(failure).rejects.toMatchObject({ places: ['webhooks.secret'] });
    await expect(stored()).resolves.toEqual(before);
  });

  it('refuses without the previous key, and changes nothing', async () => {
    const before = await stored();

    await expect(rotateMasterKey(handle.db, newOnly)).rejects.toBeInstanceOf(
      MasterKeyRotationError,
    );
    await expect(stored()).resolves.toEqual(before);
  });
});
