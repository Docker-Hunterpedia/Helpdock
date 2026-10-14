import { type DbTransaction, importMappings, importRecords } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import {
  type ImportActivity,
  type ImportMessage,
  importMappingSchema,
  importUserSchema,
} from '@helpdock/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { importedContactTarget } from './contact-target.js';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { importedIdentity } from './external-ids.js';
import type { ImportRunScope } from './run-scope.js';
import { threadAuthorKinds } from './thread-author-kinds.js';

export async function resolveThreadAuthors(
  tx: DbTransaction,
  request: ImportRunScope & {
    references: Pick<ImportMessage | ImportActivity, 'authorExternalId' | 'authorKind'>[];
  },
) {
  const kinds = threadAuthorKinds(request.references);
  const authors = new Map<string, TicketLoad['authors'][string]>();
  for (const [externalId, kind] of kinds) {
    if (kind === 'customer') {
      const pointer = await importedIdentity(tx, request, 'contact', externalId);
      if (!pointer) throw new ImportLoadError('author-unmapped');
      const contact = await importedContactTarget(tx, {
        brandId: request.brandId,
        contactId: pointer.helpdockId,
      });
      authors.set(externalId, { kind: 'contact', id: contact.id });
      continue;
    }
    const [row] = await tx
      .select()
      .from(importMappings)
      .where(
        and(
          eq(importMappings.brandId, request.brandId),
          eq(importMappings.runId, request.runId),
          eq(importMappings.kind, 'agent'),
          eq(importMappings.externalValue, externalId),
        ),
      );
    if (!row) throw new ImportLoadError('author-unmapped');
    const mapping = importMappingSchema.parse({
      kind: row.kind,
      externalValue: row.externalValue,
      target: row.target,
    });
    if (mapping.kind !== 'agent') throw new ImportLoadError('mapping-invalid');
    if (mapping.target.kind === 'name') {
      const [user] = await tx
        .select()
        .from(importRecords)
        .where(
          and(
            eq(importRecords.brandId, request.brandId),
            eq(importRecords.runId, request.runId),
            eq(importRecords.entity, 'user'),
            eq(importRecords.externalId, externalId),
            inArray(importRecords.status, ['staged', 'loaded', 'skipped']),
          ),
        );
      if (!user) throw new ImportLoadError('author-unmapped');
      const native = importUserSchema.parse(user.payload);
      if (
        native.externalId !== externalId ||
        native.kind !== 'agent' ||
        hashImportValue(native) !== user.payloadHash
      )
        throw new ImportLoadError('mapping-invalid');
      authors.set(externalId, { kind: 'name', name: native.name });
    } else {
      const pointer = await importedIdentity(tx, request, 'user', externalId);
      if (
        !pointer ||
        (mapping.target.kind === 'existing' && mapping.target.userId !== pointer.helpdockId)
      )
        throw new ImportLoadError('author-unmapped');
      authors.set(externalId, { kind: 'staff', id: pointer.helpdockId });
    }
  }
  return Object.fromEntries(authors);
}
