import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_ROLE_NAME,
  brands,
  createDb,
  type DbHandle,
  runMigrations,
  withSystem,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPerfDataset } from './dataset.js';

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
    'Skipping the performance dataset integration test: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the performance dataset', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withStartupTimeout(CONTAINER_STARTUP_MS)
      .start();
    await runMigrations({
      migrationUrl: container.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    app = createDb({
      url: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`,
    });
  }, CONTAINER_STARTUP_MS);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('seeds the required knowledge chunks only in the measured brand (#154)', async () => {
    const dataset = await seedPerfDataset(app.db, {
      measured: { tickets: 1, contacts: 1, knowledgeChunks: 7, messagesPerTicket: 1 },
      others: { tickets: 1, contacts: 1, knowledgeChunks: 0, messagesPerTicket: 1 },
      passwordHash: 'test-password-hash',
    });
    const seededBrands = await app.db.select({ id: brands.id }).from(brands);

    const counts = new Map(
      await Promise.all(
        seededBrands.map(({ id }) =>
          withSystem(app.db, id, async (tx) => {
            const [row] = await tx.execute<{ count: number }>(
              sql`SELECT count(*)::int AS count FROM knowledge_chunks`,
            );
            return [id, row?.count ?? -1] as const;
          }),
        ),
      ),
    );

    expect(seededBrands).toHaveLength(5);
    expect(counts.get(dataset.brandId)).toBe(7);
    expect(
      seededBrands.filter(({ id }) => id !== dataset.brandId).map(({ id }) => counts.get(id)),
    ).toEqual([0, 0, 0, 0]);
  });
});
