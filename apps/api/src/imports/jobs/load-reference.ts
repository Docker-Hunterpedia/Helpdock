import {
  type DbTransaction,
  departments,
  importMappings,
  importRecords,
  importRuns,
  tags,
  teams,
} from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { importMappingSchema, importRecordSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { importedContactTarget } from '../loader/contact-target.js';
import { ImportLoadError } from '../loader/contracts.js';
import { importedIdentity } from '../loader/external-ids.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';
import { recordLoadProgress } from './record-load-progress.js';

const requestSchema = z.strictObject({ claim: importClaimSchema, recordId: z.uuid() });
const resultSchema = z.strictObject({
  state: z.enum(['loaded', 'skipped', 'already_done']),
  id: z.uuid().nullable(),
});
type Record = z.infer<typeof importRecordSchema>;

type GroupMapping = Extract<z.infer<typeof importMappingSchema>, { kind: 'group' }>;
type CustomerRecord = Extract<Record, { entity: 'user' }>;

async function customerTarget(tx: DbTransaction, claim: ImportClaim, record: CustomerRecord) {
  if (record.payload.kind !== 'customer') throw new ImportLoadError('mapping-invalid');
  const [pending] = await tx
    .select({ status: importRecords.status })
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, claim.brandId),
        eq(importRecords.runId, claim.runId),
        eq(importRecords.entity, 'contact'),
        eq(importRecords.externalId, record.payload.externalId),
      ),
    );
  if (pending && pending.status !== 'loaded') throw new ImportLoadError('mapping-invalid');
  const [run] = await tx
    .select({ source: importRuns.source })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
  if (!run) throw new ImportClaimLost();
  const pointer = await importedIdentity(
    tx,
    { brandId: claim.brandId, source: run.source },
    'contact',
    record.payload.externalId,
  );
  if (!pointer) throw new ImportLoadError('mapping-invalid');
  await importedContactTarget(tx, { brandId: claim.brandId, contactId: pointer.helpdockId });
  return {
    id: pointer.helpdockId,
    selection: { kind: 'contact', contactId: pointer.helpdockId },
  };
}

async function groupTarget(tx: DbTransaction, claim: ImportClaim, mapping: GroupMapping) {
  const [department] = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(
      and(eq(departments.brandId, claim.brandId), eq(departments.id, mapping.target.departmentId)),
    );
  if (!department) throw new ImportLoadError('mapping-invalid');
  if (mapping.target.teamId) {
    const [team] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.brandId, claim.brandId),
          eq(teams.id, mapping.target.teamId),
          eq(teams.departmentId, mapping.target.departmentId),
        ),
      );
    if (!team) throw new ImportLoadError('mapping-invalid');
  }
  return { id: mapping.target.teamId ?? department.id, selection: mapping.target };
}

async function referenceTarget(tx: DbTransaction, claim: ImportClaim, record: Record) {
  if (record.entity === 'user') return customerTarget(tx, claim, record);
  if (record.entity !== 'group' && record.entity !== 'tag')
    throw new ImportLoadError('mapping-invalid');
  const [row] = await tx
    .select()
    .from(importMappings)
    .where(
      and(
        eq(importMappings.brandId, claim.brandId),
        eq(importMappings.runId, claim.runId),
        eq(importMappings.kind, record.entity),
        eq(
          importMappings.externalValue,
          record.entity === 'tag' ? record.payload.name : record.payload.externalId,
        ),
      ),
    );
  if (!row) throw new ImportLoadError('mapping-invalid');
  const mapping = importMappingSchema.parse({
    kind: row.kind,
    externalValue: row.externalValue,
    target: row.target,
  });
  if (mapping.kind === 'group') return groupTarget(tx, claim, mapping);
  if (mapping.kind !== 'tag') throw new ImportLoadError('mapping-invalid');
  if (mapping.target.tagId) {
    const [tag] = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.brandId, claim.brandId), eq(tags.id, mapping.target.tagId)));
    if (!tag) throw new ImportLoadError('mapping-invalid');
  }
  return { id: mapping.target.tagId, selection: mapping.target };
}

/** Reference rows resolve existing targets; they create no accounts, departments, tags or side effects. */
export async function loadStagedReference(
  tx: DbTransaction,
  request: { claim: ImportClaim; recordId: string },
) {
  const { claim, recordId } = requestSchema.parse(request);
  if (claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, claim);
  const predicate = and(
    eq(importRecords.id, recordId),
    eq(importRecords.brandId, claim.brandId),
    eq(importRecords.runId, claim.runId),
  );
  const [row] = await tx.select().from(importRecords).where(predicate).for('update');
  if (!row) throw new ImportLoadError('target-unavailable');
  const record = importRecordSchema.parse({ entity: row.entity, payload: row.payload });
  if (
    record.payload.externalId !== row.externalId ||
    hashImportValue(record.payload) !== row.payloadHash
  )
    throw new ImportLoadError('mapping-invalid');
  const target = await referenceTarget(tx, claim, record);
  const loadHash = hashImportValue({ payloadHash: row.payloadHash, selection: target.selection });
  if (row.status === 'loaded' || row.status === 'skipped') {
    if (row.loadHash !== loadHash || row.helpdockId !== target.id)
      throw new ImportLoadError('mapping-invalid');
    return resultSchema.parse({ state: 'already_done', id: target.id });
  }
  if (row.status !== 'staged') throw new ImportLoadError('mapping-invalid');
  const status = target.id === null ? 'skipped' : 'loaded';
  await tx
    .update(importRecords)
    .set({ status, helpdockId: target.id, loadHash, error: null })
    .where(predicate);
  await recordLoadProgress(tx, { claim, entity: record.entity, status });
  return resultSchema.parse({ state: status, id: target.id });
}
