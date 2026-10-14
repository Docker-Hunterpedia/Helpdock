import { type DbTransaction, importExternalIds, importRecords, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { importAttachmentSchema, importEntitySchema, importRecordSchema } from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError, type TicketLoad, ticketLoadSchema } from '../loader/contracts.js';
import { ImportWriter } from '../loader/import-writer.js';
import { requireImportedTicket } from '../loader/load-ticket.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';

const writer = new ImportWriter();
const MAX_STAGED_THREAD_BYTES = 50 * 1024 * 1024;
const loadedCountsSchema = z.partialRecord(importEntitySchema, z.int().nonnegative());
const checkpointRequestSchema = z.strictObject({
  claim: importClaimSchema,
  recordId: z.uuid(),
  input: ticketLoadSchema,
});
type StagedRow = typeof importRecords.$inferSelect;

async function stagedTicket(tx: DbTransaction, claim: ImportClaim, recordId: string) {
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
  if (!row) throw new ImportLoadError('target-unavailable');
  return row;
}

async function ticketChildren(tx: DbTransaction, claim: ImportClaim, externalId: string) {
  const filter = and(
    eq(importRecords.brandId, claim.brandId),
    eq(importRecords.runId, claim.runId),
    eq(importRecords.parentExternalId, externalId),
    inArray(importRecords.entity, ['message', 'csat', 'attachment']),
  );
  const [footprint] = await tx
    .select({
      bytes: sql<string>`coalesce(sum(octet_length(${importRecords.payload}::text)), 0)::text`,
    })
    .from(importRecords)
    .where(filter);
  if (!footprint) throw new ImportLoadError('target-unavailable');
  if (BigInt(footprint.bytes) > BigInt(MAX_STAGED_THREAD_BYTES))
    throw new ImportLoadError('thread-too-large');
  return tx.select().from(importRecords).where(filter).for('update');
}

function validateStagedThread(children: StagedRow[], input: TicketLoad): void {
  for (const entity of ['message', 'csat'] as const) {
    const expected = entity === 'message' ? input.messages : input.csat;
    const rows = children.filter((row) => row.entity === entity);
    if (
      rows.length !== expected.length ||
      new Set(expected.map((record) => record.externalId)).size !== expected.length
    )
      throw new ImportLoadError('mapping-invalid');
    const suppliedById = new Map(
      expected.map((record) => [record.externalId, hashImportValue(record)]),
    );
    for (const row of rows) {
      const parsed = importRecordSchema.parse({ entity: row.entity, payload: row.payload });
      const suppliedHash = suppliedById.get(row.externalId);
      if (suppliedHash !== hashImportValue(parsed.payload))
        throw new ImportLoadError('mapping-invalid');
    }
  }
  const hashesByMessage = new Map(
    input.messages.map((message) => [
      message.externalId,
      new Set(message.attachments.map(hashImportValue)),
    ]),
  );
  const allHashes = new Set([...hashesByMessage.values()].flatMap((hashes) => [...hashes]));
  for (const row of children.filter((row) => row.entity === 'attachment')) {
    const {
      ticketExternalId: _ticket,
      messageExternalId,
      ...ref
    } = importAttachmentSchema.parse(row.payload);
    const allowed =
      messageExternalId === undefined ? allHashes : hashesByMessage.get(messageExternalId);
    if (!allowed?.has(hashImportValue(ref))) throw new ImportLoadError('mapping-invalid');
  }
}

async function markTicketChildren(tx: DbTransaction, input: TicketLoad, children: StagedRow[]) {
  for (const entity of ['message', 'csat', 'attachment'] as const) {
    const rows = children.filter((row) => row.entity === entity);
    for (let offset = 0; offset < rows.length; offset += 1000)
      await markChildBatch(tx, input, entity, rows.slice(offset, offset + 1000));
  }
}

async function markChildBatch(
  tx: DbTransaction,
  input: TicketLoad,
  entity: 'message' | 'csat' | 'attachment',
  rows: StagedRow[],
) {
  const identities = await tx
    .select({ externalId: importExternalIds.externalId, id: importExternalIds.helpdockId })
    .from(importExternalIds)
    .where(
      and(
        eq(importExternalIds.brandId, input.brandId),
        eq(importExternalIds.source, input.source),
        eq(importExternalIds.entity, entity),
        inArray(
          importExternalIds.externalId,
          rows.map((row) => row.externalId),
        ),
      ),
    );
  const byExternalId = new Map(identities.map((identity) => [identity.externalId, identity.id]));
  const pointers = rows.map((row) => {
    const helpdockId = byExternalId.get(row.externalId);
    if (!helpdockId) throw new ImportLoadError('target-unavailable');
    return { id: row.id, helpdock_id: helpdockId };
  });
  await tx.execute(sql`UPDATE import_records AS staged
    SET status = 'loaded', helpdock_id = pointers.helpdock_id, error = NULL
    FROM jsonb_to_recordset(${JSON.stringify(pointers)}::jsonb) AS pointers(id uuid, helpdock_id uuid)
    WHERE staged.id = pointers.id AND staged.brand_id = ${input.brandId} AND staged.run_id = ${input.runId}`);
}

async function loadProgress(tx: DbTransaction, claim: ImportClaim, rows: StagedRow[]) {
  const [run] = await tx
    .select({ counts: importRuns.counts })
    .from(importRuns)
    .where(eq(importRuns.id, claim.runId));
  if (!run) throw new ImportClaimLost();
  const loaded = loadedCountsSchema.parse(run.counts.loaded ?? {});
  for (const row of rows)
    if (row.status !== 'loaded') loaded[row.entity] = (loaded[row.entity] ?? 0) + 1;
  await tx
    .update(importRuns)
    .set({ counts: { ...run.counts, loaded } })
    .where(eq(importRuns.id, claim.runId));
}

/** Domain writes and every staged thread checkpoint commit together, inside the fenced ticket transaction. */
export async function loadStagedTicket(
  tx: DbTransaction,
  request: {
    claim: ImportClaim;
    recordId: string;
    input: TicketLoad;
  },
) {
  const { claim, recordId, input } = checkpointRequestSchema.parse(request);
  if (claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, claim);
  const row = await stagedTicket(tx, claim, recordId);
  const [run] = await tx
    .select({ source: importRuns.source })
    .from(importRuns)
    .where(eq(importRuns.id, claim.runId));
  if (
    input.record.externalId !== row.externalId ||
    hashImportValue(
      importRecordSchema.parse({ entity: 'ticket', payload: row.payload }).payload,
    ) !== row.payloadHash ||
    input.brandId !== claim.brandId ||
    input.runId !== claim.runId ||
    input.source !== run?.source ||
    hashImportValue(input.record) !== row.payloadHash
  )
    throw new ImportLoadError('mapping-invalid');
  if (row.status === 'loaded') {
    if (!row.helpdockId) throw new ImportLoadError('target-unavailable');
    await requireImportedTicket(tx, input, row.helpdockId);
    return { state: 'already_loaded' as const, ticketId: row.helpdockId };
  }
  if (row.status !== 'staged') throw new ImportLoadError('mapping-invalid');
  const children = await ticketChildren(tx, claim, row.externalId);
  validateStagedThread(children, input);
  const loaded = await writer.ticket(tx, input);
  await markTicketChildren(tx, input, children);
  await tx
    .update(importRecords)
    .set({ status: 'loaded', helpdockId: loaded.ticketId, error: null })
    .where(eq(importRecords.id, row.id));
  await loadProgress(tx, claim, [row, ...children]);
  return { state: 'loaded' as const, ...loaded };
}
