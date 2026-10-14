import { type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import { resolveThreadAuthors } from '../loader/resolve-thread-authors.js';
import { validatedStagedRecord } from '../preflight/staged-record.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';
import { loadMappedStagedTicket } from './load-mapped-ticket.js';
import { stagedTicketChildren } from './load-ticket-checkpoint.js';

const requestSchema = z.strictObject({ claim: importClaimSchema, recordId: z.uuid() });

export async function loadAssembledStagedTicket(
  tx: DbTransaction,
  request: { claim: ImportClaim; recordId: string },
) {
  const { claim, recordId } = requestSchema.parse(request);
  if (claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, claim);
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.id, recordId),
        eq(importRecords.brandId, claim.brandId),
        eq(importRecords.runId, claim.runId),
        eq(importRecords.entity, 'ticket'),
      ),
    )
    .for('update');
  const [run] = await tx
    .select({ source: importRuns.source })
    .from(importRuns)
    .where(and(eq(importRuns.id, claim.runId), eq(importRuns.brandId, claim.brandId)));
  if (!row || !run) throw new ImportLoadError('target-unavailable');
  const native = validatedStagedRecord(row);
  if (native.entity !== 'ticket') throw new ImportLoadError('mapping-invalid');
  const children = await stagedTicketChildren(tx, claim, row.externalId);
  const messages = [];
  const csat = [];
  const activities = [];
  for (const child of children) {
    if (!['staged', 'loaded'].includes(child.status)) throw new ImportLoadError('mapping-invalid');
    const parsed = validatedStagedRecord(child);
    if (
      'ticketExternalId' in parsed.payload &&
      parsed.payload.ticketExternalId !== native.payload.externalId
    )
      throw new ImportLoadError('mapping-invalid');
    if (parsed.entity === 'message') messages.push(parsed.payload);
    else if (parsed.entity === 'csat') csat.push(parsed.payload);
    else if (parsed.entity === 'activity') activities.push(parsed.payload);
  }
  const scope = { brandId: claim.brandId, runId: claim.runId, source: run.source };
  const references: Parameters<typeof resolveThreadAuthors>[1]['references'] = [
    ...messages,
    ...activities,
  ];
  if (native.payload.assigneeExternalId)
    references.push({ authorKind: 'agent', authorExternalId: native.payload.assigneeExternalId });
  const authors = await resolveThreadAuthors(tx, { ...scope, references });
  return loadMappedStagedTicket(tx, {
    claim,
    recordId,
    input: { ...scope, record: native.payload, messages, csat, activities, authors },
  });
}
