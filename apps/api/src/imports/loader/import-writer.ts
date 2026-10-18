import { type DbTransaction, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { mappedTicketLoadSchema, type TicketLoad } from './contracts.js';
import { validatedImportedCustom } from './custom-values.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import type { FieldLoad } from './field-contracts.js';
import type { ArticleLoad, CategoryLoad, SectionLoad } from './knowledge-contracts.js';
import { loadImportedActivities } from './load-activities.js';
import { loadImportedArticle } from './load-articles.js';
import { loadImportedContact } from './load-contacts.js';
import { loadImportedCsat } from './load-csat.js';
import { loadImportedField } from './load-fields.js';
import {
  importMessageHash,
  loadImportedMessages,
  requireImportedMessageTargets,
} from './load-messages.js';
import { loadImportedOrganization } from './load-organizations.js';
import { loadImportedParticipants } from './load-participants.js';
import { loadImportedStaff } from './load-staff.js';
import { loadImportedTags } from './load-tags.js';
import { loadImportedCategory, loadImportedSection } from './load-taxonomy.js';
import {
  createImportedTicket,
  importedTicketChanges,
  lockImportedTicket,
  requireImportedTicket,
  updateImportedTicket,
} from './load-ticket.js';
import { validateTicketMappings } from './mapping-scope.js';
import type { ContactLoad, OrganizationLoad } from './profile-contracts.js';
import { reconcileImportedSla } from './reconcile-sla.js';
import { requireLoadingRun } from './run-scope.js';
import type { StaffLoad } from './staff-contracts.js';

/** The caller owns one system-job transaction per ticket; this module emits no live-ticket events. */
export class ImportWriter {
  article(tx: DbTransaction, input: ArticleLoad) {
    return loadImportedArticle(tx, input);
  }
  category(tx: DbTransaction, input: CategoryLoad) {
    return loadImportedCategory(tx, input);
  }
  section(tx: DbTransaction, input: SectionLoad) {
    return loadImportedSection(tx, input);
  }
  field(tx: DbTransaction, input: FieldLoad) {
    return loadImportedField(tx, input);
  }
  staff(tx: DbTransaction, input: StaffLoad) {
    return loadImportedStaff(tx, input);
  }
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
    const input = mappedTicketLoadSchema.parse(request);
    await lockImportedTicket(tx, { ...input, externalId: input.record.externalId });
    await requireLoadingRun(tx, input);
    const payloadHash = hashImportValue({
      ticket: input.record,
      messages: input.messages.map(importMessageHash),
      csat: input.csat,
      activities: input.activities,
      resolved: input.resolved,
      authors: input.authors,
    });
    const existing = await importedIdentity(tx, input, 'ticket', input.record.externalId);
    let previousDepartmentId: string | undefined;
    if (existing) {
      previousDepartmentId = (await requireImportedTicket(tx, input, existing.helpdockId))
        .departmentId;
      await requireImportedMessageTargets(tx, input, existing.helpdockId);
    }
    if (existing?.payloadHash === payloadHash)
      return { ticketId: existing.helpdockId, outcome: 'unchanged', messages: 0 };
    input.resolved.custom = await validatedImportedCustom(tx, {
      brandId: input.brandId,
      target: 'ticket',
      custom: input.resolved.custom,
      operation: 'create',
    });
    const state = await validateTicketMappings(tx, input);
    const ticketId = existing?.helpdockId ?? uuidv7();
    const changes = importedTicketChanges(input, state);
    if (existing) await updateImportedTicket(tx, { input, ticketId, changes });
    else await createImportedTicket(tx, { input, ticketId, changes });
    const appended = await loadImportedMessages(tx, input, ticketId);
    await loadImportedActivities(tx, input, ticketId);
    await loadImportedTags(tx, input, ticketId);
    await loadImportedParticipants(tx, input, ticketId);
    await loadImportedCsat(tx, input, ticketId);
    if (existing && previousDepartmentId)
      await reconcileImportedSla(tx, input, ticketId, previousDepartmentId);
    await rememberImported(tx, {
      brandId: input.brandId,
      source: input.source,
      runId: input.runId,
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
