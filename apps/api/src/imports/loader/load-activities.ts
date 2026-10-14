import { type DbTransaction, ticketActivity, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { ImportActivity } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { importedActivityValues } from './activity-values.js';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { importedAuthor } from './load-authors.js';

async function loadActivity(
  tx: DbTransaction,
  input: TicketLoad,
  request: { ticketId: string; event: ImportActivity },
) {
  const { ticketId, event } = request;
  const payloadHash = hashImportValue({
    event,
    author: event.authorExternalId ? (input.authors[event.authorExternalId] ?? null) : null,
  });
  const existing = await importedIdentity(tx, input, 'activity', event.externalId);
  if (existing) {
    const [target] = await tx
      .select({ id: ticketActivity.id })
      .from(ticketActivity)
      .where(
        and(
          eq(ticketActivity.brandId, input.brandId),
          eq(ticketActivity.ticketId, ticketId),
          eq(ticketActivity.id, existing.helpdockId),
          eq(ticketActivity.action, 'ticket.imported.event'),
        ),
      )
      .for('update');
    if (!target) throw new ImportLoadError('target-unavailable');
    if (existing.payloadHash === payloadHash) return;
  }
  const activityId = existing?.helpdockId ?? uuidv7();
  const changes = importedActivityValues(
    input.source,
    event,
    await importedAuthor(tx, input, event),
  );
  if (existing)
    await tx.update(ticketActivity).set(changes).where(eq(ticketActivity.id, activityId));
  else
    await tx.insert(ticketActivity).values({
      id: activityId,
      brandId: input.brandId,
      ticketId,
      departmentId: input.resolved.departmentId,
      ...changes,
    });
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    entity: 'activity',
    externalId: event.externalId,
    helpdockId: activityId,
    payloadHash,
  });
}

/** Source events are inert history; their original action is metadata, never an executable lifecycle event. */
export async function loadImportedActivities(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
): Promise<void> {
  for (const event of input.activities) await loadActivity(tx, input, { ticketId, event });
}
