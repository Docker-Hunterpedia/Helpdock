import {
  brands,
  type DbTransaction,
  nextTicketNumber,
  ticketActivity,
  tickets,
} from '@helpdock/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import type { ImportScope } from './external-ids.js';

export async function lockImportedTicket(
  tx: DbTransaction,
  scope: ImportScope & { externalId: string },
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.brandId}:${scope.source}:${scope.externalId}`}, 17))`,
  );
}

export function importedTicketChanges(
  input: TicketLoad,
  state: 'open' | 'on_hold' | 'escalated' | 'closed',
) {
  const closedAt =
    state === 'closed'
      ? new Date(input.record.closedAt ?? input.record.solvedAt ?? input.record.updatedAt)
      : null;
  return {
    subject: input.record.subject,
    statusId: input.resolved.statusId,
    departmentId: input.resolved.departmentId,
    priority: input.resolved.priority,
    channel: input.resolved.channel,
    teamId: input.resolved.teamId,
    assigneeId: input.resolved.assigneeId,
    contactId: input.resolved.contactId,
    custom: input.resolved.custom,
    updatedAt: new Date(input.record.updatedAt),
    statusChangedAt: new Date(
      input.record.closedAt ?? input.record.solvedAt ?? input.record.updatedAt,
    ),
    closedAt,
  };
}
type TicketWrite = {
  input: TicketLoad;
  ticketId: string;
  changes: ReturnType<typeof importedTicketChanges>;
};

function availableImportedTicket(input: TicketLoad, ticketId: string) {
  return and(
    eq(tickets.id, ticketId),
    eq(tickets.brandId, input.brandId),
    eq(tickets.importSource, input.source),
    isNull(tickets.deletedAt),
  );
}

export async function requireImportedTicket(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
) {
  const [found] = await tx
    .select({ id: tickets.id, departmentId: tickets.departmentId })
    .from(tickets)
    .where(availableImportedTicket(input, ticketId))
    .for('update');
  if (!found) throw new ImportLoadError('target-unavailable');
  return found;
}

export async function createImportedTicket(
  tx: DbTransaction,
  { input, ticketId, changes }: TicketWrite,
): Promise<void> {
  const [brand] = await tx
    .select({ prefix: brands.prefix, status: brands.status })
    .from(brands)
    .where(eq(brands.id, input.brandId));
  if (brand?.status !== 'active') throw new ImportLoadError('mapping-invalid');
  await tx.insert(tickets).values({
    id: ticketId,
    brandId: input.brandId,
    number: await nextTicketNumber(tx, input.brandId),
    prefix: brand.prefix,
    ...changes,
    createdAt: new Date(input.record.createdAt),
    importedAt: new Date(),
    importSource: input.source,
  });
  await tx.insert(ticketActivity).values({
    brandId: input.brandId,
    departmentId: input.resolved.departmentId,
    ticketId,
    actorType: 'system',
    actorId: `import:${input.runId}`,
    action: 'ticket.imported',
    via: 'system',
    to: {
      source: input.source,
      externalId: input.record.externalId,
      number: input.record.number ?? null,
      url: input.record.sourceUrl ?? null,
      createdAt: input.record.createdAt,
    },
  });
}

export async function updateImportedTicket(
  tx: DbTransaction,
  { input, ticketId, changes }: TicketWrite,
): Promise<void> {
  const updated = await tx
    .update(tickets)
    .set({
      ...changes,
      // A content-only delta must not manufacture another stay in the same status.
      statusChangedAt: sql`CASE WHEN ${tickets.statusId} = ${changes.statusId}::uuid THEN ${tickets.statusChangedAt} ELSE ${changes.statusChangedAt.toISOString()}::timestamptz END`,
    })
    .where(availableImportedTicket(input, ticketId))
    .returning({ id: tickets.id });
  if (!updated.length) throw new ImportLoadError('target-unavailable');
}
