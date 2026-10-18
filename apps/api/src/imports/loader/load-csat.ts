import { createHash, randomBytes } from 'node:crypto';
import { csatResponses, type DbTransaction, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { ImportCsat } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import {
  type ImportScope,
  importedIdentity,
  importSourceAccountKey,
  rememberImported,
} from './external-ids.js';
import { loadImportedCsatHistory } from './load-csat-history.js';

type CsatLoad = Pick<TicketLoad, 'brandId' | 'runId' | 'source' | 'csat'> & {
  resolved: Pick<TicketLoad['resolved'], 'departmentId'>;
};

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

export async function requireImportedCsatAnswer(
  tx: DbTransaction,
  options: { id: string; ticketId: string; externalId: string; scope: ImportScope },
): Promise<void> {
  const [existing] = await tx
    .select({ id: csatResponses.id })
    .from(csatResponses)
    .where(
      and(
        eq(csatResponses.id, options.id),
        eq(csatResponses.brandId, options.scope.brandId),
        eq(csatResponses.ticketId, options.ticketId),
        eq(csatResponses.importedSource, options.scope.source),
        eq(csatResponses.importedExternalId, options.externalId),
        eq(csatResponses.importSourceAccountKey, await importSourceAccountKey(tx, options.scope)),
      ),
    )
    .for('update');
  if (!existing) throw new ImportLoadError('target-unavailable');
}

async function updateImportedAnswer(
  tx: DbTransaction,
  options: {
    id: string;
    ticketId: string;
    rating: ImportCsat;
    unchanged: boolean;
    scope: ImportScope;
  },
): Promise<void> {
  await requireImportedCsatAnswer(tx, { ...options, externalId: options.rating.externalId });
  if (options.unchanged) return;
  await tx
    .update(csatResponses)
    .set(importedAnswer(options.rating))
    .where(eq(csatResponses.id, options.id));
}

/** Imported answers have expired, random tokens and cannot become a live survey. */
async function insertImportedAnswer(
  tx: DbTransaction,
  options: { input: CsatLoad; id: string; ticketId: string; rating: ImportCsat },
): Promise<void> {
  await tx.insert(csatResponses).values({
    id: options.id,
    brandId: options.input.brandId,
    ticketId: options.ticketId,
    departmentId: options.input.resolved.departmentId,
    ...importedAnswer(options.rating),
    importedSource: options.input.source,
    importSourceAccountKey: await importSourceAccountKey(tx, options.input),
    importedExternalId: options.rating.externalId,
    tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    expiresAt: new Date(0),
    ratedVia: 'import',
    createdAt: new Date(options.rating.ratedAt),
  });
}

export async function loadImportedCsat(
  tx: DbTransaction,
  input: CsatLoad,
  ticketId: string,
): Promise<{ changed: boolean }> {
  let changed = false;
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
        scope: input,
      });
    else await insertImportedAnswer(tx, { input, id, ticketId, rating });
    await loadImportedCsatHistory(tx, {
      id,
      brandId: input.brandId,
      ticketId,
      departmentId: input.resolved.departmentId,
      source: input.source,
      answer: rating,
      unchanged: identity?.payloadHash === payloadHash,
    });
    if (identity?.payloadHash === payloadHash) continue;
    changed = true;
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
  return { changed };
}
