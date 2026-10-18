import { type DbTransaction, importFiles, importRecords, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { importSourceSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import { importRunRefSchema, lockImportBrand } from './claims.js';

const accountSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((account) => account === account.trim());
const keyRequestSchema = z.strictObject({
  source: importSourceSchema,
  verifiedAccount: accountSchema,
});
const bindSchema = importRunRefSchema.extend({ verifiedAccount: accountSchema });

/** Canonical provider identifiers, not credentials, determine repeat/delta identity. */
export function sourceAccountKey(request: z.infer<typeof keyRequestSchema>) {
  return hashImportValue(keyRequestSchema.parse(request));
}

/** The connection service calls this only after the connector verifies its canonical account. */
export async function bindImportSourceAccount(
  tx: DbTransaction,
  request: z.infer<typeof bindSchema>,
) {
  const input = bindSchema.parse(request);
  await lockImportBrand(tx, input.brandId);
  const predicate = and(eq(importRuns.brandId, input.brandId), eq(importRuns.id, input.runId));
  const [run] = await tx.select().from(importRuns).where(predicate).for('update');
  if (!run || !['draft', 'connecting'].includes(run.status))
    throw new ImportLoadError('mapping-invalid');
  const key = sourceAccountKey({ source: run.source, verifiedAccount: input.verifiedAccount });
  if (run.mode === 'delta') {
    if (!run.parentRunId) throw new ImportLoadError('mapping-invalid');
    const [parent] = await tx
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(
        and(
          eq(importRuns.brandId, input.brandId),
          eq(importRuns.id, run.parentRunId),
          eq(importRuns.source, run.source),
          eq(importRuns.sourceAccountKey, key),
          eq(importRuns.status, 'completed'),
        ),
      );
    if (!parent) throw new ImportLoadError('mapping-invalid');
  }
  if (run.sourceAccountKey === key) return key;
  const [record] = await tx
    .select({ id: importRecords.id })
    .from(importRecords)
    .where(and(eq(importRecords.brandId, input.brandId), eq(importRecords.runId, input.runId)))
    .limit(1);
  if (record) throw new ImportLoadError('mapping-invalid');
  const [file] = await tx
    .select({ id: importFiles.id })
    .from(importFiles)
    .where(and(eq(importFiles.brandId, input.brandId), eq(importFiles.runId, input.runId)))
    .limit(1);
  if (file) throw new ImportLoadError('mapping-invalid');
  await tx.update(importRuns).set({ sourceAccountKey: key }).where(predicate);
  return key;
}
