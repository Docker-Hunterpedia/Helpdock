import {
  type Attachment as AttachmentRow,
  attachments,
  brands,
  type DbTransaction,
  type NewAttachment,
  tickets,
} from '@helpdock/db';
import type { AttachmentStatus } from '@helpdock/schemas';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

/**
 * Every statement the attachment endpoints and the media worker make.
 *
 * As in `tickets.repository.ts`, nothing here filters by brand or department:
 * the transaction carries the scope and the policies of DOMAIN-RULES §1.3
 * apply it. That is what makes DOMAIN-RULES §4.5 structural — an attachment on
 * another department's ticket is `undefined` from {@link MediaRepository.find},
 * so there is no row to build a presigned URL from.
 *
 * `brands` is the one exception, because it is a global table with no policy,
 * so the content-policy read names the brand id.
 */
export class MediaRepository {
  /**
   * The brand's content policy, as stored. `undefined` when the brand is gone.
   *
   * It is a key of `brands.settings` rather than a column of its own (M1-01
   * added that column and M1-10 nested into it), so what comes back is whatever
   * jsonb holds and `readContentPolicy` is what makes it a policy.
   */
  async contentPolicy(tx: DbTransaction, brandId: string): Promise<unknown | undefined> {
    const rows = await tx
      .select({ settings: brands.settings })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return (rows[0]?.settings as { contentPolicy?: unknown } | undefined)?.contentPolicy;
  }

  /**
   * The ticket's department, and the proof that the ticket is one this
   * transaction may reach at all — `undefined` covers both "no such ticket" and
   * "not in your departments", which the policy makes the same thing.
   *
   * Without it the `attachments_department` trigger would answer the same
   * question with a raw `insufficient_privilege`, which is a 500 rather than a
   * sentence.
   */
  async ticketDepartment(tx: DbTransaction, ticketId: string): Promise<string | undefined> {
    const rows = await tx
      .select({ departmentId: tickets.departmentId })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);

    return rows[0]?.departmentId;
  }

  async insert(tx: DbTransaction, values: NewAttachment): Promise<AttachmentRow> {
    const [row] = await tx.insert(attachments).values(values).returning();
    /* c8 ignore next 3 -- an insert refused by a policy raises rather than returning nothing. */
    if (row === undefined) {
      throw new Error('The attachment insert returned no row');
    }

    return row;
  }

  /**
   * One attachment whose ticket is still there.
   *
   * The join is what makes a soft-deleted ticket (M1-08) take its attachments
   * out of reach with it: the row survives, so without it a presigned download
   * could still be issued for a ticket the desk has deleted.
   */
  async find(tx: DbTransaction, attachmentId: string): Promise<AttachmentRow | undefined> {
    const rows = await tx
      .select({ attachment: attachments })
      .from(attachments)
      .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
      .where(and(eq(attachments.id, attachmentId), isNull(tickets.deletedAt)))
      .limit(1);

    return rows[0]?.attachment;
  }

  /**
   * The attachments of a page of messages, grouped by message and oldest first.
   *
   * One statement for the whole page rather than one per row: a thread of
   * twenty-five messages would otherwise be twenty-six round trips, and the
   * ticket read is the api's p95 (REQUIREMENTS §5.2).
   */
  async ofMessages(
    tx: DbTransaction,
    messageIds: readonly string[],
  ): Promise<Map<string, AttachmentRow[]>> {
    const grouped = new Map<string, AttachmentRow[]>();
    if (messageIds.length === 0) {
      return grouped;
    }

    const rows = await tx
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, [...messageIds]))
      .orderBy(asc(attachments.createdAt));

    for (const row of rows) {
      /* c8 ignore next 3 -- the filter above only returns attached rows. */
      if (row.messageId === null) {
        continue;
      }
      const forMessage = grouped.get(row.messageId);
      if (forMessage === undefined) {
        grouped.set(row.messageId, [row]);
      } else {
        forMessage.push(row);
      }
    }

    return grouped;
  }

  /**
   * The rows a message may claim: named ids, on this ticket, not yet attached
   * to any message. Ownership and status are decided by the caller so the
   * refusal can say which rule it broke.
   */
  async claimable(
    tx: DbTransaction,
    ticketId: string,
    attachmentIds: readonly string[],
  ): Promise<AttachmentRow[]> {
    if (attachmentIds.length === 0) {
      return [];
    }

    return tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.ticketId, ticketId),
          inArray(attachments.id, [...attachmentIds]),
          isNull(attachments.messageId),
        ),
      );
  }

  /**
   * Points the named rows at a message, and at the ticket that message is on.
   *
   * `ticketId` is normally the one they already carry, so the write is a no-op
   * for that column. It differs only when the reply landed on a continuation of
   * the ticket the uploads were made against (`media/link.ts` says why), and
   * setting it keeps an attachment on the same ticket as the message that
   * renders it.
   */
  async attachToMessage(
    tx: DbTransaction,
    { messageId, ticketId }: { messageId: string; ticketId: string },
    attachmentIds: readonly string[],
  ): Promise<number> {
    if (attachmentIds.length === 0) {
      return 0;
    }

    const rows = await tx
      .update(attachments)
      .set({ messageId, ticketId })
      .where(and(inArray(attachments.id, [...attachmentIds]), isNull(attachments.messageId)))
      .returning({ id: attachments.id });

    return rows.length;
  }

  async setStatus(
    tx: DbTransaction,
    attachmentId: string,
    values: Partial<
      Pick<
        NewAttachment,
        'status' | 'rejectReason' | 'scanStatus' | 'mime' | 'size' | 'variants' | 'processedAt'
      >
    >,
  ): Promise<AttachmentRow | undefined> {
    const rows = await tx
      .update(attachments)
      .set(values)
      .where(eq(attachments.id, attachmentId))
      .returning();

    return rows[0];
  }

  /**
   * Moves a row to `processing` only from `pending`, and reports whether this
   * caller is the one that moved it.
   *
   * `UPDATE … WHERE status = 'pending' RETURNING` is the whole test: two
   * confirms racing on the same attachment both reach the database, and exactly
   * one gets a row back. Reading and then writing would let both pass.
   */
  async startProcessing(
    tx: DbTransaction,
    attachmentId: string,
    size: number,
  ): Promise<AttachmentRow | undefined> {
    const rows = await tx
      .update(attachments)
      .set({ status: 'processing', size })
      .where(and(eq(attachments.id, attachmentId), eq(attachments.status, 'pending')))
      .returning();

    return rows[0];
  }

  /** Only a row still in one of these states may be deleted by its uploader. */
  async remove(
    tx: DbTransaction,
    attachmentId: string,
    states: readonly AttachmentStatus[],
  ): Promise<boolean> {
    const rows = await tx
      .delete(attachments)
      .where(and(eq(attachments.id, attachmentId), inArray(attachments.status, [...states])))
      .returning({ id: attachments.id });

    return rows.length === 1;
  }
}
