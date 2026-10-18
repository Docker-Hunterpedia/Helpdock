import { type DbTransaction, hcArticles, importRecords, importRuns } from '@helpdock/db';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

const scopeSchema = z.strictObject({ brandId: z.uuid(), runId: z.uuid() });
const idsSchema = z.array(z.object({ id: z.uuid() })).max(10);

/** The event carries a run ID; keyset pages avoid buffering an unbounded article-ID list or bodies. */
export async function forEachImportedArticleBatch(
  tx: DbTransaction,
  request: z.infer<typeof scopeSchema>,
  consume: (ids: string[]) => Promise<void>,
) {
  const scope = scopeSchema.parse(request);
  const [run] = await tx
    .select({ status: importRuns.status })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (run?.status !== 'completed') throw new Error('import.event-run-unavailable');
  let after: string | undefined;
  let total = 0;
  while (true) {
    const rows = idsSchema.parse(
      await tx
        .selectDistinct({ id: importRecords.helpdockId })
        .from(importRecords)
        .innerJoin(
          hcArticles,
          and(
            eq(hcArticles.id, importRecords.helpdockId),
            eq(hcArticles.brandId, importRecords.brandId),
          ),
        )
        .where(
          and(
            eq(importRecords.brandId, scope.brandId),
            eq(importRecords.runId, scope.runId),
            eq(importRecords.entity, 'article'),
            eq(importRecords.status, 'loaded'),
            isNotNull(importRecords.helpdockId),
            after ? gt(importRecords.helpdockId, after) : undefined,
          ),
        )
        .orderBy(importRecords.helpdockId)
        .limit(10),
    );
    if (rows.length === 0) return total;
    await consume(rows.map((row) => row.id));
    total += rows.length;
    after = rows.at(-1)?.id;
  }
}
