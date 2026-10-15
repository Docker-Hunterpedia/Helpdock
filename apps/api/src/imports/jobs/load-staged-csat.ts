import { type DbTransaction, importRecords, importRuns, tickets } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { ImportCsat } from '@helpdock/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportScope, importedIdentity, rememberImported } from '../loader/external-ids.js';
import { loadImportedCsat, requireImportedCsatAnswer } from '../loader/load-csat.js';
import { lockImportedTicket } from '../loader/load-ticket.js';
import { validatedStagedRecord } from '../preflight/staged-record.js';
import { ImportClaimLost, importClaimSchema, renewImportClaim } from './claims.js';
import { recordLoadProgress } from './record-load-progress.js';

const requestSchema = z.strictObject({ claim: importClaimSchema, recordId: z.uuid() });

async function existingParent(tx: DbTransaction, scope: ImportScope, rating: ImportCsat) {
  const [staged] = await tx
    .select({ id: importRecords.id })
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'ticket'),
        eq(importRecords.externalId, rating.ticketExternalId),
      ),
    )
    .limit(1);
  // Bundled children belong to the complete thread checkpoint, never this independent path.
  if (staged) throw new ImportLoadError('mapping-invalid');
  await lockImportedTicket(tx, { ...scope, externalId: rating.ticketExternalId });
  const identity = await importedIdentity(tx, scope, 'ticket', rating.ticketExternalId);
  if (!identity) throw new ImportLoadError('target-unavailable');
  const [ticket] = await tx
    .select({ id: tickets.id, departmentId: tickets.departmentId })
    .from(tickets)
    .where(
      and(
        eq(tickets.id, identity.helpdockId),
        eq(tickets.brandId, scope.brandId),
        eq(tickets.importSource, scope.source),
        isNull(tickets.deletedAt),
      ),
    )
    .for('update');
  if (!ticket) throw new ImportLoadError('target-unavailable');
  return { identity, ticket };
}

async function readAnswer(tx: DbTransaction, { claim, recordId }: z.infer<typeof requestSchema>) {
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
        eq(importRecords.entity, 'csat'),
      ),
    )
    .for('update');
  const [run] = await tx
    .select({ source: importRuns.source })
    .from(importRuns)
    .where(and(eq(importRuns.id, claim.runId), eq(importRuns.brandId, claim.brandId)));
  if (!row || !run) throw new ImportLoadError('target-unavailable');
  const record = validatedStagedRecord(row);
  if (record.entity !== 'csat' || row.parentExternalId !== record.payload.ticketExternalId)
    throw new ImportLoadError('mapping-invalid');
  const scope = { ...claim, source: run.source };
  return { row, record, scope };
}

type AnswerContext = Awaited<ReturnType<typeof readAnswer>> & {
  parent: Awaited<ReturnType<typeof existingParent>>;
  loadHash: string;
};

async function checkpointAnswer(tx: DbTransaction, context: AnswerContext) {
  const { row, record, scope, parent, loadHash } = context;
  const claim = scope;
  const result = await loadImportedCsat(
    tx,
    {
      ...scope,
      csat: [record.payload],
      resolved: { departmentId: parent.ticket.departmentId },
    },
    parent.ticket.id,
  );
  if (result.changed)
    await rememberImported(tx, {
      ...parent.identity,
      runId: claim.runId,
      payloadHash: hashImportValue({
        kind: 'independent-csat',
        previous: parent.identity.payloadHash,
        externalId: record.payload.externalId,
        payloadHash: row.payloadHash,
      }),
    });
  const answer = await importedIdentity(tx, scope, 'csat', record.payload.externalId);
  if (!answer) throw new ImportLoadError('target-unavailable');
  await tx
    .update(importRecords)
    .set({ status: 'loaded', helpdockId: answer.helpdockId, loadHash, error: null })
    .where(eq(importRecords.id, row.id));
  await recordLoadProgress(tx, {
    claim,
    entity: 'csat',
    status: 'loaded',
    reportTicketsChanged: result.changed,
  });
  return { state: 'loaded' as const };
}

/** Rescanned answers may change without an incremental ticket; retain its local history and ownership. */
export async function loadStagedCsat(tx: DbTransaction, request: z.input<typeof requestSchema>) {
  const context = await readAnswer(tx, requestSchema.parse(request));
  const { row, record, scope } = context;
  const parent = await existingParent(tx, scope, record.payload);
  const loadHash = hashImportValue({ payloadHash: row.payloadHash, ticketId: parent.ticket.id });
  if (row.status === 'loaded') {
    const answer = await importedIdentity(tx, scope, 'csat', record.payload.externalId);
    if (row.loadHash !== loadHash || !answer || answer.helpdockId !== row.helpdockId)
      throw new ImportLoadError('mapping-invalid');
    await requireImportedCsatAnswer(tx, {
      id: answer.helpdockId,
      ticketId: parent.ticket.id,
      externalId: record.payload.externalId,
      scope,
    });
    return { state: 'already_loaded' as const };
  }
  if (row.status !== 'staged') throw new ImportLoadError('mapping-invalid');
  return checkpointAnswer(tx, { ...context, parent, loadHash });
}
