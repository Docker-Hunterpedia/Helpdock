import { type DbTransaction, importMappings } from '@helpdock/db';
import { importMappingSchema, importSourceSchema, importTicketSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { importedContactTarget } from './contact-target.js';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { importedIdentity } from './external-ids.js';
import { resolveImportedCustom } from './resolve-custom-fields.js';
import { requireLoadingRun } from './run-scope.js';
import { selectTicketMappings } from './ticket-mapping-selection.js';

const requestSchema = z.strictObject({
  brandId: z.uuid(),
  runId: z.uuid(),
  source: importSourceSchema,
  record: importTicketSchema,
});
type Request = z.infer<typeof requestSchema>;

async function contactReference(tx: DbTransaction, input: Request, externalId: string) {
  const pointer = await importedIdentity(tx, input, 'contact', externalId);
  if (!pointer) throw new ImportLoadError('mapping-invalid');
  return (
    await importedContactTarget(tx, { brandId: input.brandId, contactId: pointer.helpdockId })
  ).id;
}

async function staffReference(
  tx: DbTransaction,
  input: Request,
  selection: ReturnType<typeof selectTicketMappings>,
) {
  if (!selection.assignee || selection.assignee.kind === 'name') return null;
  const externalId = input.record.assigneeExternalId;
  if (!externalId) throw new ImportLoadError('mapping-invalid');
  const pointer = await importedIdentity(tx, input, 'user', externalId);
  if (
    !pointer ||
    (selection.assignee.kind === 'existing' && pointer.helpdockId !== selection.assignee.userId)
  )
    throw new ImportLoadError('mapping-invalid');
  return pointer.helpdockId;
}

export async function resolveTicketMappings(
  tx: DbTransaction,
  request: Request,
): Promise<TicketLoad['resolved']> {
  const input = requestSchema.parse(request);
  await requireLoadingRun(tx, input);
  const rows = await tx
    .select()
    .from(importMappings)
    .where(and(eq(importMappings.brandId, input.brandId), eq(importMappings.runId, input.runId)));
  const mappings = rows.map((row) =>
    importMappingSchema.parse({
      kind: row.kind,
      externalValue: row.externalValue,
      target: row.target,
    }),
  );
  const selection = selectTicketMappings(input.record, mappings);
  const ccContacts = [];
  for (const externalId of input.record.ccExternalIds ?? [])
    ccContacts.push({ externalId, contactId: await contactReference(tx, input, externalId) });
  return {
    statusId: selection.statusId,
    departmentId: selection.departmentId,
    teamId: selection.teamId,
    priority: selection.priority,
    channel: selection.channel,
    tags: selection.tags,
    assigneeId: await staffReference(tx, input, selection),
    contactId: input.record.requesterExternalId
      ? await contactReference(tx, input, input.record.requesterExternalId)
      : null,
    ccContacts,
    custom: await resolveImportedCustom(tx, {
      ...input,
      target: 'ticket',
      custom: input.record.custom,
      operation: 'create',
    }),
  };
}
