import type { Settings } from '@helpdock/config';
import {
  APP_ROLE_NAME,
  auditLog,
  brands,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  runMigrations,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable } from '../../testing/docker-available.js';
import { RpIdPinStore } from './rp-id-pin.js';

/**
 * `pinIfUnset` called with a request's own transaction (a brand-scoped one,
 * which cannot see install settings until the pin widens it): the pin and its
 * audit row land with the request, once, and a rollback takes them back.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the RP ID pin integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const BRAND_A = uuidv7();
const PINNED_ACTION = 'auth.passkey.rp_pinned';

describe.skipIf(!hasDocker)('RpIdPinStore.pinIfUnset inside a request transaction', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;
  let store: RpIdPinStore;

  const inBrandA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(
      app.db,
      {
        brandIds: [BRAND_A],
        departmentIds: 'all',
        principalType: 'staff',
        principalId: uuidv7(),
      },
      fn,
    );

  const pinAudits = async () =>
    (
      await withSystem(app.db, INSTALL_SCOPE_BRAND_ID, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, PINNED_ACTION)),
      )
    ).length;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations({
      migrationUrl: container.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    app = createDb({
      url: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`,
    });
    await app.db.insert(brands).values({ id: BRAND_A, name: 'Acme', prefix: 'ACME' });
    store = new RpIdPinStore({
      db: app.db,
      settings: { isLockedByEnv: () => false } as unknown as Settings,
    });
  }, CONTAINER_STARTUP_MS);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('removes the pin and its audit row with a rolled-back request', async () => {
    await expect(
      inBrandA(async (tx) => {
        await expect(store.pinIfUnset('desk.example.com', tx)).resolves.toMatchObject({
          rpId: 'desk.example.com',
        });
        throw new Error('the request failed');
      }),
    ).rejects.toThrow('the request failed');

    expect(await store.read()).toBeNull();
    expect(await pinAudits()).toBe(0);
  });

  it('pins and audits once with the request, and a second call changes nothing', async () => {
    const first = await inBrandA((tx) => store.pinIfUnset('desk.example.com', tx));
    const second = await inBrandA((tx) => store.pinIfUnset('other.example.com', tx));

    expect(first.rpId).toBe('desk.example.com');
    expect(second.rpId).toBe('desk.example.com');
    expect((await store.read())?.rpId).toBe('desk.example.com');
    expect(await pinAudits()).toBe(1);
  });
});
