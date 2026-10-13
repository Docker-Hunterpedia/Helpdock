import { type DbTransaction, importRuns, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { and, eq, sql } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad, ticketLoadSchema } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { importMessageHash, loadImportedMessages } from './load-messages.js';
import {
  createImportedTicket,
  importedTicketChanges,
  updateImportedTicket,
} from './load-ticket.js';
import { validateTicketMappings } from './mapping-scope.js';

async function visibleRun(tx: DbTransaction, input: TicketLoad): Promise<void> {
  const [run] = await tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.id, input.runId),
        eq(importRuns.brandId, input.brandId),
        eq(importRuns.source, input.source),
        eq(importRuns.status, 'loading'),
      ),
    );
  if (!run) throw new ImportLoadError('mapping-invalid');
}

/** The caller owns one system-job transaction per ticket; this module emits no live-ticket events. */
export class ImportWriter {
  async ticket(
    tx: DbTransaction,
    request: TicketLoad,
  ): Promise<{ ticketId: string; outcome: 'created' | 'updated' | 'unchanged'; messages: number }> {
    const input = ticketLoadSchema.parse(request);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${input.source}:${input.record.externalId}`}, 17))`,
    );
    await visibleRun(tx, input);
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
