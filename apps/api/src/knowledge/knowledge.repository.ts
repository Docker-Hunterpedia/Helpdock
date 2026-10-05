import {
  type DbTransaction,
  type KnowledgeSource,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  knowledgeSyncLog,
  users,
  uuidv7,
} from '@helpdock/db';
import type {
  KnowledgeLogCode,
  KnowledgeLogLevel,
  KnowledgeLogLine,
  KnowledgeVisibility,
} from '@helpdock/schemas';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { PreparedChunk } from './prepare.js';

/**
 * Every read and write of the knowledge tables (M7-03), in the caller's brand
 * transaction: the request's for the admin routes, a short system one per
 * document for the sync job. Row-level security scopes each to the brand.
 */

export type NewSource = Pick<
  typeof knowledgeSources.$inferInsert,
  'kind' | 'name' | 'visibility' | 'schedule' | 'config' | 'configEncrypted' | 'createdBy'
>;

export interface SourceCounts {
  readonly documents: number;
  readonly chunks: number;
  readonly embedded: number;
}

export interface SourceRow {
  readonly source: KnowledgeSource;
  readonly counts: SourceCounts;
  readonly createdByName: string | null;
}

export interface DocumentWrite {
  readonly brandId: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly title: string;
  readonly url: string | null;
  readonly articleId: string | null;
  readonly contentHash: string;
  readonly visibility: KnowledgeVisibility;
  readonly chunks: readonly PreparedChunk[];
}

export interface LogWrite {
  readonly brandId: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly level: KnowledgeLogLevel;
  readonly code: KnowledgeLogCode;
  readonly params?: Record<string, unknown>;
}

/** A claim older than this belongs to a worker that died mid-run, and may be taken over. */
export const STALE_SYNC_MS = 2 * 60 * 60 * 1_000;

export class KnowledgeRepository {
  async list(tx: DbTransaction, activeModel: string | null): Promise<SourceRow[]> {
    const rows = await tx
      .select({ source: knowledgeSources, createdByName: users.name })
      .from(knowledgeSources)
      .leftJoin(users, sql`${users.id}::text = ${knowledgeSources.createdBy}`)
      .orderBy(asc(knowledgeSources.createdAt));
    const counts = await this.#counts(
      tx,
      rows.map((row) => row.source.id),
      activeModel,
    );
    return rows.map((row) => ({
      source: row.source,
      createdByName: row.createdByName,
      counts: counts.get(row.source.id) ?? { documents: 0, chunks: 0, embedded: 0 },
    }));
  }

  async find(tx: DbTransaction, sourceId: string): Promise<KnowledgeSource | undefined> {
    const [row] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .limit(1);
    return row;
  }

  async row(
    tx: DbTransaction,
    sourceId: string,
    activeModel: string | null,
  ): Promise<SourceRow | undefined> {
    const [row] = await tx
      .select({ source: knowledgeSources, createdByName: users.name })
      .from(knowledgeSources)
      .leftJoin(users, sql`${users.id}::text = ${knowledgeSources.createdBy}`)
      .where(eq(knowledgeSources.id, sourceId))
      .limit(1);
    if (row === undefined) {
      return undefined;
    }
    const counts = await this.#counts(tx, [sourceId], activeModel);
    return {
      ...row,
      counts: counts.get(sourceId) ?? { documents: 0, chunks: 0, embedded: 0 },
    };
  }

  async #counts(
    tx: DbTransaction,
    sourceIds: readonly string[],
    activeModel: string | null,
  ): Promise<Map<string, SourceCounts>> {
    if (sourceIds.length === 0) {
      return new Map();
    }
    const chunks = await tx
      .select({
        sourceId: knowledgeChunks.sourceId,
        chunks: sql<number>`count(*)::int`,
        embedded: sql<number>`(count(*) filter (where ${knowledgeChunks.embeddingModel} = ${activeModel ?? ''}))::int`,
      })
      .from(knowledgeChunks)
      .where(inArray(knowledgeChunks.sourceId, [...sourceIds]))
      .groupBy(knowledgeChunks.sourceId);
    const documents = await tx
      .select({ sourceId: knowledgeDocuments.sourceId, documents: sql<number>`count(*)::int` })
      .from(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.sourceId, [...sourceIds]))
      .groupBy(knowledgeDocuments.sourceId);
    const result = new Map<string, SourceCounts>();
    for (const id of sourceIds) {
      const chunk = chunks.find((row) => row.sourceId === id);
      result.set(id, {
        documents: documents.find((row) => row.sourceId === id)?.documents ?? 0,
        chunks: chunk?.chunks ?? 0,
        embedded: chunk?.embedded ?? 0,
      });
    }
    return result;
  }

  async insert(tx: DbTransaction, brandId: string, source: NewSource): Promise<KnowledgeSource> {
    const [row] = await tx
      .insert(knowledgeSources)
      .values({ brandId, ...source })
      .returning();
    /* c8 ignore next 3 -- an insert returns its row. */
    if (row === undefined) {
      throw new Error('The knowledge source insert returned no row');
    }
    return row;
  }

  async update(
    tx: DbTransaction,
    sourceId: string,
    changes: Partial<typeof knowledgeSources.$inferInsert>,
  ): Promise<void> {
    await tx
      .update(knowledgeSources)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(knowledgeSources.id, sourceId));
  }

  /** Re-labels a source's chunks at once, so a re-scope reaches retrieval in the same commit. */
  async relabel(
    tx: DbTransaction,
    sourceId: string,
    visibility: KnowledgeVisibility,
  ): Promise<void> {
    await tx
      .update(knowledgeChunks)
      .set({ visibility })
      .where(eq(knowledgeChunks.sourceId, sourceId));
  }

  /** Re-labels one document's chunks, for an article whose visibility changed but not its text. */
  async relabelDocument(
    tx: DbTransaction,
    sourceId: string,
    externalId: string,
    visibility: KnowledgeVisibility,
  ): Promise<void> {
    await tx.execute(sql`
      update knowledge_chunks c set visibility = ${visibility}
      from knowledge_documents d
      where d.id = c.document_id and d.source_id = ${sourceId} and d.external_id = ${externalId}
        and c.visibility <> ${visibility}`);
  }

  /** The source and, by cascade, its documents, chunks and log: DOMAIN-RULES §11, "immediate". */
  async remove(tx: DbTransaction, sourceId: string): Promise<number> {
    const [counted] = await tx
      .select({ chunks: sql<number>`count(*)::int` })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.sourceId, sourceId));
    await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
    return counted?.chunks ?? 0;
  }

  /** The brand's help center source, created the first time an article is synced. */
  async articleSource(tx: DbTransaction, brandId: string): Promise<KnowledgeSource> {
    await tx.execute(sql`
      insert into knowledge_sources (id, brand_id, kind, name, schedule, visibility)
      values (${uuidv7()}, ${brandId}, 'article', 'Help center articles', 'automatic', 'public')
      on conflict (brand_id) where kind = 'article' do nothing`);
    const [row] = await tx
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.brandId, brandId), eq(knowledgeSources.kind, 'article')))
      .limit(1);
    /* c8 ignore next 3 -- the insert above guarantees the row. */
    if (row === undefined) {
      throw new Error('The help center knowledge source could not be created');
    }
    return row;
  }

  /**
   * Writes one document and its chunks. A document whose hash is unchanged is
   * left alone (the indexing key of DOMAIN-RULES §6); a changed one has its
   * chunks replaced, so their vectors are made again by the next embed.
   */
  async writeDocument(tx: DbTransaction, write: DocumentWrite): Promise<'unchanged' | 'written'> {
    const [existing] = await tx
      .select({ id: knowledgeDocuments.id, contentHash: knowledgeDocuments.contentHash })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.sourceId, write.sourceId),
          eq(knowledgeDocuments.externalId, write.externalId),
        ),
      )
      .limit(1);
    if (existing?.contentHash === write.contentHash) {
      return 'unchanged';
    }

    const [document] = await tx
      .insert(knowledgeDocuments)
      .values({
        brandId: write.brandId,
        sourceId: write.sourceId,
        externalId: write.externalId,
        title: write.title,
        url: write.url,
        articleId: write.articleId,
        contentHash: write.contentHash,
      })
      .onConflictDoUpdate({
        target: [knowledgeDocuments.sourceId, knowledgeDocuments.externalId],
        set: {
          title: write.title,
          url: write.url,
          contentHash: write.contentHash,
          updatedAt: new Date(),
        },
      })
      .returning({ id: knowledgeDocuments.id });
    /* c8 ignore next 3 -- an upsert returns its row. */
    if (document === undefined) {
      throw new Error('The knowledge document upsert returned no row');
    }
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, document.id));
    if (write.chunks.length > 0) {
      await tx.insert(knowledgeChunks).values(
        write.chunks.map((chunk) => ({
          brandId: write.brandId,
          sourceId: write.sourceId,
          documentId: document.id,
          articleId: write.articleId,
          ordinal: chunk.ordinal,
          locale: chunk.locale,
          visibility: write.visibility,
          content: chunk.content,
          contentHash: chunk.contentHash,
          tokenCount: chunk.tokenCount,
          suspicious: chunk.suspicious,
          meta: chunk.meta,
        })),
      );
    }
    return 'written';
  }

  /** Removes the documents a sync did not see this time: pages gone, files deleted. */
  async removeDocumentsExcept(
    tx: DbTransaction,
    sourceId: string,
    keep: readonly string[],
  ): Promise<number> {
    const removed = await tx
      .delete(knowledgeDocuments)
      .where(
        keep.length === 0
          ? eq(knowledgeDocuments.sourceId, sourceId)
          : and(
              eq(knowledgeDocuments.sourceId, sourceId),
              notInArray(knowledgeDocuments.externalId, [...keep]),
            ),
      )
      .returning({ id: knowledgeDocuments.id });
    return removed.length;
  }

  /** Removes the named documents of a source, for an article that is no longer published. */
  async removeDocuments(
    tx: DbTransaction,
    sourceId: string,
    externalIds: readonly string[],
  ): Promise<number> {
    if (externalIds.length === 0) {
      return 0;
    }
    const removed = await tx
      .delete(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.sourceId, sourceId),
          inArray(knowledgeDocuments.externalId, [...externalIds]),
        ),
      )
      .returning({ id: knowledgeDocuments.id });
    return removed.length;
  }

  async documentIds(tx: DbTransaction, sourceId: string): Promise<string[]> {
    const rows = await tx
      .select({ externalId: knowledgeDocuments.externalId })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceId, sourceId));
    return rows.map((row) => row.externalId);
  }

  /**
   * Marks the source `syncing` unless another run holds it. A claim older than
   * {@link STALE_SYNC_MS} is a worker that died, and is taken over.
   */
  async claim(tx: DbTransaction, sourceId: string, now: Date): Promise<boolean> {
    const stale = new Date(now.getTime() - STALE_SYNC_MS);
    const claimed = await tx
      .update(knowledgeSources)
      .set({
        syncStatus: 'syncing',
        syncStartedAt: now,
        progressDone: 0,
        progressTotal: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeSources.id, sourceId),
          or(
            sql`${knowledgeSources.syncStatus} <> 'syncing'`,
            isNull(knowledgeSources.syncStartedAt),
            sql`${knowledgeSources.syncStartedAt} < ${stale.toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({ id: knowledgeSources.id });
    return claimed.length === 1;
  }

  async log(tx: DbTransaction, line: LogWrite): Promise<void> {
    await tx.insert(knowledgeSyncLog).values({ ...line, params: line.params ?? {} });
  }

  async logLines(
    tx: DbTransaction,
    sourceId: string,
    { warningsOnly, limit }: { readonly warningsOnly: boolean; readonly limit: number },
  ): Promise<KnowledgeLogLine[]> {
    const rows = await tx
      .select()
      .from(knowledgeSyncLog)
      .where(
        and(
          eq(knowledgeSyncLog.sourceId, sourceId),
          warningsOnly ? inArray(knowledgeSyncLog.level, ['warn', 'error']) : undefined,
        ),
      )
      .orderBy(desc(knowledgeSyncLog.createdAt), desc(knowledgeSyncLog.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      level: row.level,
      code: row.code as KnowledgeLogCode,
      params: row.params,
      at: row.createdAt.toISOString(),
    }));
  }
}
