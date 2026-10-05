import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import {
  activeEmbeddingSpace,
  buildEmbeddingIndex,
  embeddingTarget,
  setEmbeddingDims,
  toVectorLiteral,
  updateEmbeddingSpace,
} from './embedding-space.js';
import { runMigrations } from './migrate.js';
import { APP_ROLE_NAME } from './roles.js';
import { brands, knowledgeChunks, knowledgeDocuments, knowledgeSources } from './schema/index.js';
import { withSystem } from './tenant.js';
import { uuidv7 } from './uuid.js';

/**
 * The `vector(<dims>)` column of ADR 0005, created and resized by the
 * runtime role through the owner-rights functions of migration 0036, as the
 * `knowledge.configure` job does it.
 */

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
    'Skipping the embedding space tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const brandId = uuidv7();

describe.skipIf(!hasDocker)('the embedding space', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;

  const columnDims = async (): Promise<number | null> => {
    const [row] = await app.db.execute<{ dims: number | null }>(sql`
      SELECT atttypmod AS dims FROM pg_attribute
      WHERE attrelid = 'knowledge_chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`);
    return row?.dims ?? null;
  };

  const hasIndex = async (): Promise<boolean> => {
    const rows = await app.db.execute(
      sql`SELECT 1 FROM pg_indexes WHERE indexname = 'knowledge_chunks_embedding_hnsw_idx'`,
    );
    return rows.length === 1;
  };

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
    await app.db.insert(brands).values({ id: brandId, name: 'Acme', prefix: 'ACME' });
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('starts unconfigured, with no vector column and nothing to rank', async () => {
    expect(await columnDims()).toBeNull();
    await expect(activeEmbeddingSpace(app.db)).resolves.toBeNull();
    await expect(embeddingTarget(app.db)).resolves.toBeNull();
  });

  it('lets the runtime role create the column and its HNSW index, and store a vector', async () => {
    await setEmbeddingDims(app.db, 3);
    await buildEmbeddingIndex(app.db);

    expect(await columnDims()).toBe(3);
    expect(await hasIndex()).toBe(true);

    await withSystem(app.db, brandId, async (tx) => {
      const [source] = await tx
        .insert(knowledgeSources)
        .values({ brandId, kind: 'file', name: 'policy.pdf' })
        .returning();
      const [document] = await tx
        .insert(knowledgeDocuments)
        .values({ brandId, sourceId: source?.id ?? '', externalId: 'policy.pdf', contentHash: 'h' })
        .returning();
      const [chunk] = await tx
        .insert(knowledgeChunks)
        .values({
          brandId,
          sourceId: source?.id ?? '',
          documentId: document?.id ?? '',
          ordinal: 0,
          locale: 'ar',
          visibility: 'internal',
          content: 'تتم معالجة المبالغ المستردة خلال خمسة أيام',
          contentHash: 'c',
        })
        .returning({ id: knowledgeChunks.id });
      await tx.execute(
        sql`UPDATE knowledge_chunks SET embedding = ${toVectorLiteral([0.1, 0.2, 0.3])}::vector, embedding_model = 'm1' WHERE id = ${chunk?.id ?? ''}`,
      );
      const [search] = await tx.execute<{ matches: boolean }>(
        sql`SELECT search @@ plainto_tsquery('arabic', 'المبالغ') AS matches FROM knowledge_chunks`,
      );
      expect(search?.matches).toBe(true);
    });
  });

  it('replaces the column when the dimension changes, and drops the index until it is rebuilt', async () => {
    await setEmbeddingDims(app.db, 5);

    expect(await columnDims()).toBe(5);
    expect(await hasIndex()).toBe(false);
    const [row] = await withSystem(app.db, brandId, (tx) =>
      tx.execute<{ embedding: string | null }>(sql`SELECT embedding::text FROM knowledge_chunks`),
    );
    expect(row?.embedding).toBeNull();
  });

  it('keeps the vectors when only the index is dropped for a same-dimension model change', async () => {
    await withSystem(app.db, brandId, (tx) =>
      tx.execute(
        sql`UPDATE knowledge_chunks SET embedding = ${toVectorLiteral([1, 2, 3, 4, 5])}::vector`,
      ),
    );

    await setEmbeddingDims(app.db, 5);

    const [row] = await withSystem(app.db, brandId, (tx) =>
      tx.execute<{ embedding: string | null }>(sql`SELECT embedding::text FROM knowledge_chunks`),
    );
    expect(row?.embedding).toBe('[1,2,3,4,5]');
  });

  it('refuses a dimension above the HNSW ceiling in the database too', async () => {
    const failure = await app.db
      .execute(sql`SELECT public.helpdock_set_embedding_dims(${3072}::integer)`)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(String((failure as Error | undefined)?.cause)).toMatch(/between 1 and 2000/);
  });

  it('serves vectors only while ready, and only of the active model', async () => {
    await updateEmbeddingSpace(app.db, {
      status: 'reindexing',
      targetModel: 'm2',
      targetDims: 5,
      activeModel: 'm1',
      activeDims: 5,
    });
    await expect(activeEmbeddingSpace(app.db)).resolves.toBeNull();
    await expect(embeddingTarget(app.db)).resolves.toEqual({ model: 'm2', dims: 5 });

    await updateEmbeddingSpace(app.db, { status: 'ready', activeModel: 'm2', activeDims: 5 });
    await expect(activeEmbeddingSpace(app.db)).resolves.toEqual({ model: 'm2', dims: 5 });
  });

  it('withholds the DDL functions from every role but the runtime one', async () => {
    const [row] = await app.db.execute<{ allowed: boolean }>(
      sql`SELECT has_function_privilege('public', 'public.helpdock_set_embedding_dims(integer)', 'EXECUTE') AS allowed`,
    );
    expect(row?.allowed).toBe(false);
  });
});
