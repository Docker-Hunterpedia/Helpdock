import { type DbTransaction, importRecords } from '@helpdock/db';
import { importContactPreviewRequestSchema, importContactPreviewSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { lockImportBrand } from '../jobs/claims.js';
import { ImportLoadError } from '../loader/contracts.js';
import { previewImportedContactSource } from './contact-source-plan.js';
import { requireImportPreviewRun } from './preview-run.js';
import { validatedStagedRecord } from './staged-record.js';

/** Match the contact/company plan without creating profiles, identities, verification or invitations. */
export async function previewImportedContactRecord(
  tx: DbTransaction,
  raw: z.input<typeof importContactPreviewRequestSchema>,
) {
  const { externalId, defaultCallingCode, ...scope } = importContactPreviewRequestSchema.parse(raw);
  await lockImportBrand(tx, scope.brandId);
  const run = await requireImportPreviewRun(tx, scope);
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'contact'),
        eq(importRecords.externalId, externalId),
      ),
    );
  if (!row) throw new ImportLoadError('target-unavailable');
  const native = validatedStagedRecord(row);
  if (native.entity !== 'contact') throw new ImportLoadError('mapping-invalid');
  let plan: Awaited<ReturnType<typeof previewImportedContactSource>>;
  try {
    plan = await previewImportedContactSource(tx, {
      ...scope,
      source: run.source,
      record: native.payload,
      defaultCallingCode,
    });
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new ImportLoadError('mapping-invalid');
  }
  return importContactPreviewSchema.parse({ source: native.payload, plan });
}
