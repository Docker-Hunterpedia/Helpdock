import { type DbTransaction, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { sql } from 'drizzle-orm';
import { type TicketLoad, ticketLoadSchema } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { loadImportedContact } from './load-contacts.js';
import { importMessageHash, loadImportedMessages } from './load-messages.js';
import { loadImportedOrganization } from './load-organizations.js';
import {
  createImportedTicket,
  importedTicketChanges,
  updateImportedTicket,
} from './load-ticket.js';
import { validateTicketMappings } from './mapping-scope.js';
import type { ContactLoad, OrganizationLoad } from './profile-contracts.js';
import { requireLoadingRun } from './run-scope.js';

/** The caller owns one system-job transaction per ticket; this module emits no live-ticket events. */
export class ImportWriter {
  contact(tx: DbTransaction, input: ContactLoad) {
    return loadImportedContact(tx, input);
  }
  organization(tx: DbTransaction, input: OrganizationLoad) {
    return loadImportedOrganization(tx, input);
  }
  async ticket(
    tx: DbTransaction,
    request: TicketLoad,
  ): Promise<{ ticketId: string; outcome: 'created' | 'updated' | 'unchanged'; messages: number }> {
    const input = ticketLoadSchema.parse(request);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${input.source}:${input.record.externalId}`}, 17))`,
    );
    await requireLoadingRun(tx, input);
    const payloadHash = hashImportValue({
      ticket: input.record,
      messages: input.messages.map(importMessageHash),
      resolved: input.resolved,
      authors: input.authors,
    });
    const existing = await importedIdentity(tx, input, 'ticket', input.record.externalId);
    if (existing?.payloadHash === payloadHash)
      return { ticketId: existing.helpdockId, outcome: 'unchanged', messages: 0 };
    const state = await validateTicketMappings(tx, input);
    const ticketId = existing?.helpdockId ?? uuidv7();
    const changes = importedTicketChanges(input, state);
    if (existing) await updateImportedTicket(tx, { input, ticketId, changes });
    else await createImportedTicket(tx, { input, ticketId, changes });
    const appended = await loadImportedMessages(tx, input, ticketId);
    await rememberImported(tx, {
      brandId: input.brandId,
      source: input.source,
      entity: 'ticket',
      externalId: input.record.externalId,
      helpdockId: ticketId,
      payloadHash,
      sourceUrl: input.record.sourceUrl ?? null,
      sourceNumber: input.record.number ?? null,
    });
    return { ticketId, outcome: existing ? 'updated' : 'created', messages: appended };
  }
}
