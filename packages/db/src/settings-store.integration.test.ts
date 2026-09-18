import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKeyring, createSettings, LocalInvalidation, type Settings } from '@helpdock/config';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { APP_ROLE_NAME } from './roles.js';
import { brands, settings } from './schema/index.js';
import { PostgresSettingsStore } from './settings-store.js';
import { INSTALL_SCOPE_BRAND_ID, withSystem } from './tenant.js';
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
    'Skipping the settings store tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });
const brandId = uuidv7();

describe.skipIf(!hasDocker)('PostgresSettingsStore', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let installStore: PostgresSettingsStore;
  let install: Settings;
  let brand: Settings;

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
    await handle.db.insert(brands).values({ id: brandId, name: 'Acme', prefix: 'ACME' });

    installStore = new PostgresSettingsStore({ db: handle.db });
    install = createSettings({
      env: {},
      store: installStore,
      keyring,
      invalidation: new LocalInvalidation(),
    });
    brand = createSettings({
      env: {},
      store: new PostgresSettingsStore({ db: handle.db, brandId }),
      keyring,
      invalidation: new LocalInvalidation(),
    });
  });

  afterAll(async () => {
    await install?.close();
    await brand?.close();
    await handle?.close();
    await container?.stop();
  });

  it('falls back to the registry default until something is stored', async () => {
    await expect(install.get('smtp.port')).resolves.toBe(587);
  });

  it('round-trips a value through Postgres', async () => {
    await install.set('smtp.host', 'smtp.example.com', { updatedBy: 'wizard' });

    await expect(install.get('smtp.host')).resolves.toBe('smtp.example.com');
    const stored = await installStore.read('smtp.host');
    expect(stored).toMatchObject({ key: 'smtp.host', updatedBy: 'wizard' });
    expect(stored?.updatedAt).toBeInstanceOf(Date);
  });

  it('overwrites the row instead of adding a second one', async () => {
    await install.set('smtp.host', 'smtp.example.org', { updatedBy: 'user-1' });

    const rows = await withSystem(handle.db, INSTALL_SCOPE_BRAND_ID, (tx) =>
      tx.select().from(settings).where(eq(settings.key, 'smtp.host')),
    );

    expect(rows).toHaveLength(1);
    await expect(install.get('smtp.host')).resolves.toBe('smtp.example.org');
  });

  it('stores a secret as the encrypted envelope and never as plain text', async () => {
    await install.set('smtp.password', 'hunter2', { updatedBy: 'wizard' });

    const stored = await installStore.read('smtp.password');
    expect(stored?.value.startsWith('v1.')).toBe(true);
    expect(stored?.value).not.toContain('hunter2');
    await expect(install.get('smtp.password')).resolves.toBe('hunter2');
  });

  it('keeps a brand scope apart from the install scope', async () => {
    await brand.set('smtp.host', 'smtp.acme.test', { updatedBy: 'user-1' });

    await expect(brand.get('smtp.host')).resolves.toBe('smtp.acme.test');
    await expect(install.get('smtp.host')).resolves.toBe('smtp.example.org');
  });

  it('lists the rows of its own scope', async () => {
    const keys = (await installStore.list()).map((row) => row.key);

    expect(keys).toContain('smtp.host');
    expect(keys).toContain('smtp.password');
    expect(await new PostgresSettingsStore({ db: handle.db, brandId }).list()).toHaveLength(1);
  });

  it('leaves a key the registry no longer declares out of the list', async () => {
    await withSystem(handle.db, INSTALL_SCOPE_BRAND_ID, (tx) =>
      tx.insert(settings).values({
        key: 'smtp.retired',
        brandId: INSTALL_SCOPE_BRAND_ID,
        value: '"kept"',
        updatedBy: 'test',
      }),
    );

    // The row stays, so a downgrade does not lose it; it is simply not a
    // `SettingKey` and does not belong in a typed result.
    expect((await installStore.list()).map((row) => row.key)).not.toContain('smtp.retired');
  });
});
