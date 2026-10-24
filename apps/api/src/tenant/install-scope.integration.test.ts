import {
  APP_ROLE_NAME,
  brands,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  runMigrations,
  settings,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable } from '../testing/docker-available.js';
import { withInstallScope } from './install-scope.js';

/**
 * `withInstallScope` against real row-level security. `readSsoSetting` falls
 * back to the default when the policy hides the row, so a widening that did not
 * work would read `sso.enforced` as false without any error; this is the proof
 * that it works, and that the brands are put back.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the install-scope integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const BRAND_A = uuidv7();

describe.skipIf(!hasDocker)('withInstallScope', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;

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
    await withSystem(app.db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
      await tx.insert(settings).values({
        key: 'sso.enforced',
        brandId: INSTALL_SCOPE_BRAND_ID,
        value: 'true',
        updatedBy: 'test',
      });
    });
  }, CONTAINER_STARTUP_MS);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  const readEnforced = (tx: Parameters<Parameters<typeof inBrandA>[0]>[0]) =>
    tx
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.brandId, INSTALL_SCOPE_BRAND_ID), eq(settings.key, 'sso.enforced')));

  const brandIdsOf = async (tx: Parameters<Parameters<typeof inBrandA>[0]>[0]) => {
    const [row] = await tx.execute<{ value: string }>(
      sql`SELECT current_setting('app.brand_ids', true) AS value`,
    );
    return row?.value;
  };

  it('shows the install setting only inside the widening, and puts the brands back', async () => {
    await inBrandA(async (tx) => {
      expect(await readEnforced(tx)).toEqual([]);

      const inside = await withInstallScope(tx, () => readEnforced(tx));

      expect(inside).toEqual([{ value: 'true' }]);
      expect(await brandIdsOf(tx)).toBe(`{${BRAND_A}}`);
      expect(await readEnforced(tx)).toEqual([]);
    });
  });

  it('puts the brands back when fn throws', async () => {
    await inBrandA(async (tx) => {
      await expect(
        withInstallScope(tx, async () => {
          await readEnforced(tx);
          throw new Error('refused');
        }),
      ).rejects.toThrow('refused');

      expect(await brandIdsOf(tx)).toBe(`{${BRAND_A}}`);
      expect(await readEnforced(tx)).toEqual([]);
    });
  });
});
