import {
  attachments,
  auditLog,
  type DbTransaction,
  type RetentionSettingsRow,
  retentionSettings,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import type { RetentionCounts } from '@helpdock/schemas';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  lt,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { PurgeableAttachment } from '../media/object-purge.js';
import type { RetentionWindowColumns } from './retention-rules.js';

/**
 * Every statement M1-14 makes. Nothing here opens a transaction: the request's
 * or the job's is passed in, so row-level security has already narrowed every
 * read to one brand. The brand is still named in each `WHERE` — a staff
 * principal's transaction may carry several brands, and "which brand's
 * windows?" must not depend on how many the caller belongs to.
 */

/** The seeded Spam statuses of the brand (`ticket_statuses.is_spam`). */
const spamStatusIds = (tx: DbTransaction, brandId: string) =>
  tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.brandId, brandId), eq(ticketStatuses.isSpam, true)));

/**
 * Closed more than N days ago, and not spam: spam runs on a clock of its own
 * (§11), so a spam ticket is never purged early because the closed-ticket
 * window happens to be shorter, and never counted in both rows of the form.
 */
const closedTicketCondition = (tx: DbTransaction, brandId: string, cutoff: Date): SQL =>
  and(
    eq(tickets.brandId, brandId),
    isNotNull(tickets.closedAt),
    lt(tickets.closedAt, cutoff),
    notInArray(tickets.statusId, spamStatusIds(tx, brandId)),
  ) as SQL;

/**
 * In the Spam status for more than N days. `closed_at` is when it entered a
 * closed state, which marking it spam is; `updated_at` stands in only for a row
 * that somehow has none.
 */
const spamTicketCondition = (tx: DbTransaction, brandId: string, cutoff: Date): SQL =>
  and(
    eq(tickets.brandId, brandId),
    inArray(tickets.statusId, spamStatusIds(tx, brandId)),
    // A raw fragment has no column to encode a Date through, so it is bound as text.
    sql`coalesce(${tickets.closedAt}, ${tickets.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
  ) as SQL;

export type TicketPurgeKind = 'closed' | 'spam';

export class RetentionRepository {
  // ----------------------------------------------------------------- settings

  async find(tx: DbTransaction, brandId: string): Promise<RetentionSettingsRow | undefined> {
    const rows = await tx
      .select()
      .from(retentionSettings)
      .where(eq(retentionSettings.brandId, brandId))
      .limit(1);

    return rows[0];
  }

  async save(
    tx: DbTransaction,
    brandId: string,
    values: RetentionWindowColumns,
    actorId: string,
  ): Promise<void> {
    const changes = { ...values, updatedBy: actorId, updatedAt: new Date() };
    await tx
      .insert(retentionSettings)
      .values({ brandId, ...changes })
      .onConflictDoUpdate({ target: retentionSettings.brandId, set: changes });
  }

  /** Stamps the run on the brand's row, creating one under the defaults if it had none. */
  async recordRun(
    tx: DbTransaction,
    brandId: string,
    at: Date,
    counts: RetentionCounts,
  ): Promise<void> {
    const run = { lastRunAt: at, lastRunCounts: counts as Record<string, number> };
    await tx
      .insert(retentionSettings)
      .values({ brandId, ...run })
      .onConflictDoUpdate({ target: retentionSettings.brandId, set: run });
  }

  // ------------------------------------------------------------------ preview

  async countTickets(
    tx: DbTransaction,
    brandId: string,
    kind: TicketPurgeKind,
    cutoff: Date,
  ): Promise<number> {
    const [row] = await tx
      .select({ total: count() })
      .from(tickets)
      .where(this.#ticketCondition(tx, brandId, kind, cutoff));

    return row?.total ?? 0;
  }

  async countAuditLog(tx: DbTransaction, brandId: string, cutoff: Date): Promise<number> {
    const [row] = await tx
      .select({ total: count() })
      .from(auditLog)
      .where(and(eq(auditLog.brandId, brandId), lt(auditLog.createdAt, cutoff)));

    return row?.total ?? 0;
  }

  // ------------------------------------------------------------------- purges

  /** The next batch of tickets to purge, oldest first. */
  async ticketBatch(
    tx: DbTransaction,
    brandId: string,
    { kind, cutoff, limit }: { kind: TicketPurgeKind; cutoff: Date; limit: number },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(this.#ticketCondition(tx, brandId, kind, cutoff))
      .orderBy(asc(tickets.closedAt), asc(tickets.id))
      .limit(limit);

    return rows.map((row) => row.id);
  }

  /** Every attachment of these tickets, including ones no message claimed. */
  async attachmentsOfTickets(
    tx: DbTransaction,
    ticketIds: readonly string[],
  ): Promise<PurgeableAttachment[]> {
    if (ticketIds.length === 0) {
      return [];
    }

    return tx
      .select({
        id: attachments.id,
        brandId: attachments.brandId,
        ticketId: attachments.ticketId,
        s3Key: attachments.s3Key,
      })
      .from(attachments)
      .where(inArray(attachments.ticketId, [...ticketIds]));
  }

  /**
   * Hard-deletes the tickets. Their messages, activity, tags and attachment
   * rows go by `ON DELETE CASCADE`, and so does whatever a later table hangs off
   * a ticket — CSAT (M1-12), AI calls (M7) — as long as it declares the same
   * cascade; `retention.integration.test.ts` fails if a foreign key into
   * `tickets` does not.
   */
  async deleteTickets(tx: DbTransaction, ticketIds: readonly string[]): Promise<number> {
    if (ticketIds.length === 0) {
      return 0;
    }

    const rows = await tx
      .delete(tickets)
      .where(inArray(tickets.id, [...ticketIds]))
      .returning({ id: tickets.id });

    return rows.length;
  }

  async purgeAuditBatch(
    tx: DbTransaction,
    brandId: string,
    cutoff: Date,
    limit: number,
  ): Promise<number> {
    const batch = tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.brandId, brandId), lt(auditLog.createdAt, cutoff)))
      .limit(limit);

    const rows = await tx
      .delete(auditLog)
      .where(inArray(auditLog.id, batch))
      .returning({ id: auditLog.id });

    return rows.length;
  }

  #ticketCondition(tx: DbTransaction, brandId: string, kind: TicketPurgeKind, cutoff: Date): SQL {
    return kind === 'closed'
      ? closedTicketCondition(tx, brandId, cutoff)
      : spamTicketCondition(tx, brandId, cutoff);
  }
}
