import { type DbTransaction, importRecords } from '@helpdock/db';
import type { ImportRecord } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportScope, importedIdentity } from '../loader/external-ids.js';
import { importAttachmentHash } from '../loader/load-attachments.js';
import { validateImportKnowledgeHierarchy } from './knowledge-hierarchy.js';
import { type ImportReference, requiredImportReferences } from './references.js';
import { validatedStagedRecord } from './staged-record.js';

export type ReferenceIssue = {
  code:
    | 'reference-missing'
    | 'reference-invalid'
    | 'reference-self'
    | 'reference-parent-mismatch'
    | 'reference-cycle';
  reference: ImportReference;
};

/** Read-only: delta references may reuse identities solely in the same brand/vendor/account namespace. */
export async function validateImportReferences(
  tx: DbTransaction,
  scope: ImportScope,
  record: ImportRecord,
) {
  const issues: ReferenceIssue[] = [];
  for (const reference of requiredImportReferences(record)) {
    if (reference.entity === record.entity && reference.externalId === record.payload.externalId) {
      issues.push({ code: 'reference-self', reference });
      continue;
    }
    const [row] = await tx
      .select()
      .from(importRecords)
      .where(
        and(
          eq(importRecords.brandId, scope.brandId),
          eq(importRecords.runId, scope.runId),
          eq(importRecords.entity, reference.entity),
          eq(importRecords.externalId, reference.externalId),
        ),
      );
    if (!row) {
      if (!(await importedIdentity(tx, scope, reference.entity, reference.externalId)))
        issues.push({ code: 'reference-missing', reference });
      continue;
    }
    let native: ImportRecord;
    try {
      native = validatedStagedRecord(row);
    } catch (error) {
      if (!(error instanceof ImportLoadError)) throw error;
      issues.push({ code: 'reference-invalid', reference });
      continue;
    }
    if (
      native.entity === 'user' &&
      native.payload.kind !== 'agent' &&
      (reference.relation === 'assignee' || reference.relation === 'author')
    ) {
      issues.push({ code: 'reference-invalid', reference });
    }
    if (
      record.entity === 'message' &&
      native.entity === 'attachment' &&
      record.payload.attachments
        .filter((ref) => ref.externalId === reference.externalId)
        .some((ref) => importAttachmentHash(ref) !== importAttachmentHash(native.payload))
    ) {
      issues.push({ code: 'reference-invalid', reference });
    }
    if (
      record.entity === 'attachment' &&
      native.entity === 'message' &&
      native.payload.ticketExternalId !== record.payload.ticketExternalId
    )
      issues.push({ code: 'reference-parent-mismatch', reference });
  }
  if (
    (record.entity === 'category' || record.entity === 'section' || record.entity === 'article') &&
    !issues.length
  ) {
    const code = await validateImportKnowledgeHierarchy(tx, scope, record);
    if (code) {
      const references = requiredImportReferences(record);
      const reference = references.find((ref) => ref.entity === record.entity) ?? references[0];
      if (!reference) throw new ImportLoadError('mapping-invalid');
      issues.push({ code, reference });
    }
  }
  return issues;
}
