import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_ROLE_NAME,
  brands,
  createDb,
  type DbHandle,
  departments,
  runMigrations,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAllBrands } from './all-brands.js';
import { liveBrandIds } from './live-brands.js';

/**
 * The all-brands context against a real Postgres: a purged brand is outside
 * it, so row-level security hides that brand's rows from every system path
 * that routes across brands; a brand in its deletion grace is still inside,
 * because the route that finds it is the one that answers 410 for it.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the all-brands integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const ACTIVE = uuidv7();
const DELETING = uuidv7();
const DELETED = uuidv7();

describe.skipIf(!hasDocker)('withAllBrands', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;

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

    const deletedAt = new Date();
    await app.db.insert(brands).values([
      { id: ACTIVE, name: 'Acme', prefix: 'ACME', status: 'active' },
      { id: DELETING, name: 'Globex', prefix: 'GLOBEX', status: 'deleting', deletedAt },
      { id: DELETED, name: 'Initech', prefix: 'INITECH', status: 'deleted', deletedAt },
    ]);
    for (const brandId of [ACTIVE, DELETING, DELETED]) {
      await withSystem(app.db, brandId, async (tx) => {
        await tx.insert(departments).values({ brandId, name: 'Support' });
      });
    }
  }, CONTAINER_STARTUP_MS);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('lists the brands each kind of system path may act for', async () => {
    expect(await liveBrandIds(app.db, 'active')).toEqual([ACTIVE]);
    expect((await liveBrandIds(app.db, 'not-deleted')).sort()).toEqual([ACTIVE, DELETING].sort());
  });

  it('skips a purged brand and keeps one in its deletion grace', async () => {
    const rows = await withAllBrands(app.db, 'test.route', (tx) =>
      tx.select({ brandId: departments.brandId }).from(departments),
    );

    expect(rows.map((row) => row.brandId).sort()).toEqual([ACTIVE, DELETING].sort());
  });
});
