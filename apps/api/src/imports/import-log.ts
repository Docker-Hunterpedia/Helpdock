import { type DbTransaction, importLog, importRuns } from '@helpdock/db';
import {
  csvLine,
  type ImportLogPage,
  type ImportLogQuery,
  importLogPageSchema,
  importLogQuerySchema,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, lt, lte, max } from 'drizzle-orm';
import type { ImportRunRef } from './jobs/claims.js';

/** A high-water mark keeps a paged/exported log stable while workers append new entries. */
export async function readImportLog(
  tx: DbTransaction,
  scope: ImportRunRef,
  raw: ImportLogQuery,
): Promise<ImportLogPage> {
  const query = importLogQuerySchema.parse(raw);
  const [run] = await tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run) throw new NotFoundException('import.run-not-found');
  const predicate = and(eq(importLog.brandId, scope.brandId), eq(importLog.runId, scope.runId));
  const through =
    query.through ??
    (
      await tx
        .select({ id: max(importLog.id) })
        .from(importLog)
        .where(predicate)
    )[0]?.id ??
    0;
  const rows = await tx
    .select({
      id: importLog.id,
      at: importLog.at,
      level: importLog.level,
      entity: importLog.entity,
      externalId: importLog.externalId,
      message: importLog.message,
    })
    .from(importLog)
    .where(
      and(
        predicate,
        lte(importLog.id, through),
        query.level ? eq(importLog.level, query.level) : undefined,
        query.after === undefined
          ? undefined
          : query.direction === 'asc'
            ? gt(importLog.id, query.after)
            : lt(importLog.id, query.after),
      ),
    )
    .orderBy(query.direction === 'asc' ? asc(importLog.id) : desc(importLog.id))
    .limit(query.limit + 1);
  const entries = rows.slice(0, query.limit).map((row) => ({ ...row, at: row.at.toISOString() }));
  return importLogPageSchema.parse({
    entries,
    through,
    nextCursor: rows.length > query.limit ? (entries.at(-1)?.id ?? null) : null,
  });
}

/** Every emitted row was output-validated; spreadsheet formula escaping is shared with report exports. */
export async function* exportImportLog(
  first: ImportLogPage,
  next: (query: ImportLogQuery) => Promise<ImportLogPage>,
  level?: ImportLogQuery['level'],
) {
  yield csvLine(['id', 'at', 'level', 'entity', 'external_id', 'message']);
  let page = first;
  while (true) {
    for (const entry of page.entries)
      yield csvLine([
        entry.id,
        entry.at,
        entry.level,
        entry.entity,
        entry.externalId,
        entry.message,
      ]);
    if (page.nextCursor === null) return;
    page = await next({
      direction: 'asc',
      after: page.nextCursor,
      through: first.through,
      limit: 500,
      ...(level ? { level } : {}),
    });
  }
}
