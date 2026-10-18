import { type DbTransaction, importExternalIds, tickets } from '@helpdock/db';
import type { Ticket } from '@helpdock/schemas';
import { importSourceLink } from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { toTicket } from './ticket-view.js';

/** Resolve the page at once, through its already authorized parent tickets; ambiguous receipts disclose no link. */
export async function importedTicketSources(tx: DbTransaction, ids: readonly string[]) {
  const results = new Map<string, NonNullable<Ticket['imported']>>();
  if (!ids.length) return results;
  const rows = await tx
    .select({
      id: tickets.id,
      source: tickets.importSource,
      number: sql<
        string | null
      >`CASE WHEN count(${importExternalIds.externalId}) = 1 THEN coalesce(min(${importExternalIds.sourceNumber}), min(${importExternalIds.externalId})) END`,
      url: sql<
        string | null
      >`CASE WHEN count(${importExternalIds.externalId}) = 1 THEN min(${importExternalIds.sourceUrl}) END`,
    })
    .from(tickets)
    .leftJoin(
      importExternalIds,
      and(
        eq(importExternalIds.brandId, tickets.brandId),
        eq(importExternalIds.helpdockId, tickets.id),
        eq(importExternalIds.entity, 'ticket'),
        eq(importExternalIds.source, tickets.importSource),
      ),
    )
    .where(inArray(tickets.id, [...ids]))
    .groupBy(tickets.id, tickets.importSource);
  for (const row of rows)
    if (row.source)
      results.set(row.id, {
        source: row.source,
        number: row.number,
        url: importSourceLink(row.url),
      });
  return results;
}

/** Mutation responses retain provenance instead of briefly replacing it with an empty header chip. */
export async function ticketWithSource(
  tx: DbTransaction,
  ...[ticket, status, tags, contact, sla]: Parameters<typeof toTicket>
) {
  const imported = ticket.importSource
    ? ((await importedTicketSources(tx, [ticket.id])).get(ticket.id) ?? null)
    : null;
  return toTicket(ticket, status, tags, contact, sla, imported);
}
