import { type DbTransaction, importMappings, importRecords, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import {
  HC_BODY_MAX,
  type ImportRecord,
  importMappingSchema,
  importRecordSchema,
} from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import { importedIdentity } from '../loader/external-ids.js';
import { resolveImportedCustom } from '../loader/resolve-custom-fields.js';
import type { ImportRunScope } from '../loader/run-scope.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';
import { loadStagedRecord, type RecordCheckpointRequest } from './load-record-checkpoint.js';

const requestSchema = z.strictObject({
  claim: importClaimSchema,
  recordId: z.uuid(),
  preparedBodyHtml: z.string().max(HC_BODY_MAX).optional(),
  preparedPublishedBodyHtml: z.string().max(HC_BODY_MAX).optional(),
  defaultCallingCode: z
    .string()
    .regex(/^\d{0,4}$/)
    .default(''),
});
type Request = z.infer<typeof requestSchema>;

async function confirmedRecordMapping(
  tx: DbTransaction,
  scope: ImportRunScope,
  kind: 'field' | 'agent',
  externalId: string,
) {
  const [row] = await tx
    .select()
    .from(importMappings)
    .where(
      and(
        eq(importMappings.brandId, scope.brandId),
        eq(importMappings.runId, scope.runId),
        eq(importMappings.kind, kind),
        eq(importMappings.externalValue, externalId),
      ),
    );
  if (!row) throw new ImportLoadError('mapping-invalid');
  return importMappingSchema.parse({
    kind: row.kind,
    externalValue: row.externalValue,
    target: row.target,
  });
}

async function preparedOperation(
  tx: DbTransaction,
  scope: ImportRunScope,
  record: ImportRecord,
  request: Request,
): Promise<RecordCheckpointRequest['operation']> {
  switch (record.entity) {
    case 'field': {
      const mapping = await confirmedRecordMapping(tx, scope, 'field', record.payload.externalId);
      if (mapping.kind !== 'field') throw new ImportLoadError('mapping-invalid');
      return {
        entity: 'field',
        input: { ...scope, record: record.payload, mapping: mapping.target },
      };
    }
    case 'user': {
      const mapping = await confirmedRecordMapping(tx, scope, 'agent', record.payload.externalId);
      if (mapping.kind !== 'agent') throw new ImportLoadError('mapping-invalid');
      return {
        entity: 'user',
        input: { ...scope, record: record.payload, mapping: mapping.target },
      };
    }
    case 'organization':
      return {
        entity: 'organization',
        input: {
          ...scope,
          record: record.payload,
          custom: await resolveImportedCustom(tx, {
            ...scope,
            target: 'account',
            custom: record.payload.custom,
            operation: 'patch',
          }),
        },
      };
    case 'contact': {
      const company = record.payload.organizationExternalId
        ? await importedIdentity(tx, scope, 'organization', record.payload.organizationExternalId)
        : null;
      if (record.payload.organizationExternalId && !company)
        throw new ImportLoadError('mapping-invalid');
      return {
        entity: 'contact',
        input: {
          ...scope,
          record: record.payload,
          accountId: company?.helpdockId ?? null,
          defaultCallingCode: request.defaultCallingCode,
          custom: await resolveImportedCustom(tx, {
            ...scope,
            target: 'contact',
            custom: record.payload.custom,
            operation: 'patch',
          }),
        },
      };
    }
    case 'category':
      return { entity: 'category', input: { ...scope, record: record.payload } };
    case 'section':
      return { entity: 'section', input: { ...scope, record: record.payload } };
    case 'article':
      if (request.preparedBodyHtml === undefined) throw new ImportLoadError('mapping-invalid');
      return {
        entity: 'article',
        input: {
          ...scope,
          record: record.payload,
          preparedBodyHtml: request.preparedBodyHtml,
          ...(request.preparedPublishedBodyHtml === undefined
            ? {}
            : { preparedPublishedBodyHtml: request.preparedPublishedBodyHtml }),
        },
      };
    default:
      throw new ImportLoadError('mapping-invalid');
  }
}

/** Builds a load request from the immutable staged source and confirmed mapping rows. */
export async function loadPreparedStagedRecord(
  tx: DbTransaction,
  request: {
    claim: ImportClaim;
    recordId: string;
    preparedBodyHtml?: string;
    preparedPublishedBodyHtml?: string;
    defaultCallingCode?: string;
  },
) {
  const parsed = requestSchema.parse(request);
  if (parsed.claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, parsed.claim);
  const { claim, recordId } = parsed;
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.id, recordId),
        eq(importRecords.brandId, claim.brandId),
        eq(importRecords.runId, claim.runId),
      ),
    )
    .for('update');
  const [run] = await tx
    .select({ source: importRuns.source })
    .from(importRuns)
    .where(and(eq(importRuns.id, claim.runId), eq(importRuns.brandId, claim.brandId)));
  if (!row || !run) throw new ImportLoadError('target-unavailable');
  const record = importRecordSchema.parse({ entity: row.entity, payload: row.payload });
  if (
    record.payload.externalId !== row.externalId ||
    hashImportValue(record.payload) !== row.payloadHash
  )
    throw new ImportLoadError('mapping-invalid');
  const scope = { brandId: claim.brandId, runId: claim.runId, source: run.source };
  const operation = await preparedOperation(tx, scope, record, parsed);
  return loadStagedRecord(tx, { claim, recordId, operation });
}
