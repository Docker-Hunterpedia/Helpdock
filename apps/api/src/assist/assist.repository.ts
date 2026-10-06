import {
  aiCalls,
  articleProposals,
  attachments,
  brands,
  contacts,
  type DbTransaction,
  departments,
  type TicketFieldSuggestion,
  tags,
  ticketFieldSuggestions,
  ticketMessages,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

/**
 * What agent assist reads and writes (M7-05, M7-07, M7-09). Every query runs
 * in a transaction the caller opened — the agent's own, under their
 * department policy, or a worker's system transaction for the brand — so a
 * ticket the reader may not see is simply not found.
 */

export interface AssistTicket {
  readonly id: string;
  readonly brandId: string;
  readonly departmentId: string;
  readonly reference: string;
  readonly subject: string;
  readonly closed: boolean;
  readonly closedAt: Date | null;
  /** The contact's language, else the brand's. */
  readonly locale: 'en' | 'ar';
}

export interface AssistMessage {
  readonly id: string;
  readonly kind: 'public' | 'note' | 'system' | 'ai';
  readonly authorType: 'staff' | 'contact' | 'system' | 'ai';
  readonly bodyText: string;
}

export interface Named {
  readonly id: string;
  readonly name: string;
}

export class AssistRepository {
  async ticket(tx: DbTransaction, ticketId: string): Promise<AssistTicket | undefined> {
    const [row] = await tx
      .select({
        id: tickets.id,
        brandId: tickets.brandId,
        departmentId: tickets.departmentId,
        prefix: tickets.prefix,
        number: tickets.number,
        subject: tickets.subject,
        closedAt: tickets.closedAt,
        systemState: ticketStatuses.systemState,
        contactLocale: contacts.locale,
        brandLocale: brands.defaultLocale,
      })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .innerJoin(brands, eq(brands.id, tickets.brandId))
      .leftJoin(contacts, eq(contacts.id, tickets.contactId))
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      brandId: row.brandId,
      departmentId: row.departmentId,
      reference: `${row.prefix}-${String(row.number)}`,
      subject: row.subject,
      closed: row.systemState === 'closed',
      closedAt: row.closedAt,
      locale: row.contactLocale ?? row.brandLocale,
    };
  }

  /** The thread, oldest first, without system lines. */
  thread(tx: DbTransaction, ticketId: string): Promise<AssistMessage[]> {
    return tx
      .select({
        id: ticketMessages.id,
        kind: ticketMessages.kind,
        authorType: ticketMessages.authorType,
        bodyText: ticketMessages.bodyText,
      })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          inArray(ticketMessages.kind, ['public', 'note', 'ai']),
        ),
      )
      .orderBy(asc(ticketMessages.seq));
  }

  tags(tx: DbTransaction): Promise<Named[]> {
    return tx.select({ id: tags.id, name: tags.name }).from(tags).orderBy(asc(tags.name));
  }

  departments(tx: DbTransaction): Promise<Named[]> {
    return tx
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .orderBy(asc(departments.name));
  }

  async suggestions(
    tx: DbTransaction,
    ticketId: string,
  ): Promise<TicketFieldSuggestion | undefined> {
    const [row] = await tx
      .select()
      .from(ticketFieldSuggestions)
      .where(eq(ticketFieldSuggestions.ticketId, ticketId))
      .limit(1);
    return row;
  }

  /** One row per ticket: a new suggestion replaces whatever was pending. */
  async saveSuggestions(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly ticketId: string;
      readonly departmentId: string;
      readonly tagIds: readonly string[];
      readonly priority: 'low' | 'medium' | 'high' | 'urgent' | null;
      readonly suggestedDepartmentId: string | null;
      readonly source: string;
      readonly aiCallId: string | null;
    },
  ): Promise<TicketFieldSuggestion> {
    const fields = {
      tagIds: [...values.tagIds],
      priority: values.priority,
      suggestedDepartmentId: values.suggestedDepartmentId,
      source: values.source,
      aiCallId: values.aiCallId,
      createdAt: new Date(),
    };
    const [row] = await tx
      .insert(ticketFieldSuggestions)
      .values({
        brandId: values.brandId,
        ticketId: values.ticketId,
        departmentId: values.departmentId,
        ...fields,
      })
      .onConflictDoUpdate({ target: ticketFieldSuggestions.ticketId, set: fields })
      .returning();
    /* c8 ignore next 3 -- an upsert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The suggestion upsert returned no row');
    }
    return row;
  }

  /** Clears what was accepted or dismissed; the row goes when nothing is left. */
  async updateSuggestions(
    tx: DbTransaction,
    row: TicketFieldSuggestion,
    next: Pick<TicketFieldSuggestion, 'tagIds' | 'priority' | 'suggestedDepartmentId'>,
  ): Promise<TicketFieldSuggestion | undefined> {
    if (next.tagIds.length === 0 && next.priority === null && next.suggestedDepartmentId === null) {
      await tx.delete(ticketFieldSuggestions).where(eq(ticketFieldSuggestions.id, row.id));
      return undefined;
    }
    const [updated] = await tx
      .update(ticketFieldSuggestions)
      .set(next)
      .where(eq(ticketFieldSuggestions.id, row.id))
      .returning();
    return updated;
  }

  async latestProposal(
    tx: DbTransaction,
    ticketId: string,
  ): Promise<{ id: string; status: 'waiting' | 'approved' | 'rejected' } | undefined> {
    const [row] = await tx
      .select({ id: articleProposals.id, status: articleProposals.status })
      .from(articleProposals)
      .where(eq(articleProposals.ticketId, ticketId))
      .orderBy(desc(articleProposals.proposedAt))
      .limit(1);
    return row;
  }

  /** A ticket's voice notes that a transcription was asked for. */
  transcripts(tx: DbTransaction, ticketId: string) {
    return tx
      .select({
        id: attachments.id,
        status: attachments.transcriptStatus,
        text: attachments.transcriptText,
        language: attachments.transcriptLanguage,
      })
      .from(attachments)
      .where(and(eq(attachments.ticketId, ticketId), eq(attachments.kind, 'audio')))
      .orderBy(asc(attachments.createdAt));
  }

  async transcriptText(
    tx: DbTransaction,
    ticketId: string,
    attachmentId: string,
  ): Promise<string | null> {
    const [row] = await tx
      .select({ text: attachments.transcriptText })
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.ticketId, ticketId)))
      .limit(1);
    return row?.text ?? null;
  }

  async call(tx: DbTransaction, callId: string) {
    const [row] = await tx
      .select({ model: aiCalls.model, costUsd: aiCalls.costUsd, redactions: aiCalls.redactions })
      .from(aiCalls)
      .where(eq(aiCalls.id, callId))
      .limit(1);
    return row;
  }
}
