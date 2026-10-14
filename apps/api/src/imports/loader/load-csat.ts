import { createHash, randomBytes } from 'node:crypto';
import { csatResponses, type DbTransaction, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { ImportCsat } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';

function importedAnswer(rating: ImportCsat) {
  return {
    rating: rating.rating,
    comment: rating.comment ?? null,
    ratedAt: new Date(rating.ratedAt),
    closedAt: rating.closedAt ? new Date(rating.closedAt) : null,
    sentAt: new Date(rating.ratedAt),
    importedDetails: rating.sourceDetails ?? null,
  };
}

async function updateImportedAnswer(
  tx: DbTransaction,
  options: { id: string; ticketId: string; rating: ImportCsat; unchanged: boolean },
): Promise<void> {
  const [existing] = await tx
    .select({ ticketId: csatResponses.ticketId })
    .from(csatResponses)
    .where(eq(csatResponses.id, options.id));
  if (!existing || existing.ticketId !== options.ticketId)
    throw new ImportLoadError('mapping-invalid');
  if (options.unchanged) return;
  await tx
    .update(csatResponses)
    .set(importedAnswer(options.rating))
    .where(eq(csatResponses.id, options.id));
}

/** Imported answers have expired, random tokens and cannot become a live survey. */
async function insertImportedAnswer(
  tx: DbTransaction,
  options: { input: TicketLoad; id: string; ticketId: string; rating: ImportCsat },
): Promise<void> {
  await tx.insert(csatResponses).values({
    id: options.id,
    brandId: options.input.brandId,
    ticketId: options.ticketId,
    departmentId: options.input.resolved.departmentId,
    ...importedAnswer(options.rating),
    importedSource: options.input.source,
    importedExternalId: options.rating.externalId,
    tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    expiresAt: new Date(0),
    ratedVia: 'import',
    createdAt: new Date(options.rating.ratedAt),
  });
}

export async function loadImportedCsat(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
): Promise<void> {
  for (const rating of input.csat) {
    const identity = await importedIdentity(tx, input, 'csat', rating.externalId);
    const payloadHash = hashImportValue(rating);
    const id = identity?.helpdockId ?? uuidv7();
    if (identity)
      await updateImportedAnswer(tx, {
        id,
        ticketId,
        rating,
        unchanged: identity.payloadHash === payloadHash,
      });
    else await insertImportedAnswer(tx, { input, id, ticketId, rating });
    if (identity?.payloadHash === payloadHash) continue;
    await rememberImported(tx, {
      brandId: input.brandId,
      source: input.source,
      runId: input.runId,
      entity: 'csat',
      externalId: rating.externalId,
      helpdockId: id,
      payloadHash,
    });
  }
}
