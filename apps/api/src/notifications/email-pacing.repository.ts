import {
  brands,
  contacts,
  type DbTransaction,
  jobReceipts,
  notificationEmailBatches,
  notificationEmailPacing,
  notificationPrefs,
  notifications,
  tickets,
  users,
} from '@helpdock/db';
import { type NotificationKind, notificationDetailSchema } from '@helpdock/schemas';
import { and, asc, eq, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from './email-batch-content.js';
import type { PacingState } from './email-pacing.js';
import { DEFAULT_EMAIL_PREFERENCES, type EmailPreferences } from './email-recheck.js';

/**
 * The statements M14-10's pacing runs, always in the worker's brand system
 * transaction (DOMAIN-RULES §1.4). The pacing row is the lock: every path that
 * changes a person's batches in a brand takes it first, so scheduling, a
 * send, the digest tick and the rebuild never interleave for one person.
 */

export type BatchKind = 'immediate' | 'hourly' | 'daily';
export type EmailState =
  | 'pending'
  | 'sent'
  | 'skipped_read'
  | 'skipped_paused'
  | 'skipped_off'
  | 'skipped_scope'
  | 'skipped_failed'
  | 'skipped_unconfigured';

export interface BatchRow {
  readonly id: string;
  readonly brandId: string;
  readonly userId: string;
  readonly kind: BatchKind;
  readonly status: 'pending' | 'sent' | 'empty' | 'failed';
  readonly sendFailures: number;
  readonly scheduledFor: Date;
  readonly urgent: boolean;
  readonly heldSince: Date | null;
  readonly seenOnlineAt: Date | null;
  readonly createdAt: Date;
  readonly digestTickAt: Date | null;
}

export interface ScheduleFacts {
  readonly id: string;
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly emailState: string | null;
  readonly emailBatchId: string | null;
  readonly email: boolean;
  readonly createdAt: Date;
}

export interface BatchItemRow extends BatchItem {
  readonly readAt: Date | null;
  readonly email: boolean;
  /** Null when the ticket is gone. */
  readonly ticketDepartmentId: string | null;
}

export interface Recipient {
  readonly name: string;
  readonly email: string;
  readonly locale: 'en' | 'ar';
}

const reference = sql<string>`${tickets.prefix} || '-' || ${tickets.number}::text`;

const batchColumns = {
  id: notificationEmailBatches.id,
  brandId: notificationEmailBatches.brandId,
  userId: notificationEmailBatches.userId,
  kind: notificationEmailBatches.kind,
  status: notificationEmailBatches.status,
  scheduledFor: notificationEmailBatches.scheduledFor,
  urgent: notificationEmailBatches.urgent,
  heldSince: notificationEmailBatches.heldSince,
  seenOnlineAt: notificationEmailBatches.seenOnlineAt,
  createdAt: notificationEmailBatches.createdAt,
  digestTickAt: notificationEmailBatches.digestTickAt,
  sendFailures: notificationEmailBatches.sendFailures,
};

const toPreferences = (
  row:
    | {
        readonly emailSchedule: EmailPreferences['schedule'];
        readonly digestHour: number;
        readonly pausedUntil: Date | null;
        readonly emailUnsubscribedAt: Date | null;
      }
    | undefined,
): EmailPreferences =>
  row === undefined
    ? DEFAULT_EMAIL_PREFERENCES
    : {
        schedule: row.emailSchedule,
        digestHour: row.digestHour,
        pausedUntil: row.pausedUntil,
        unsubscribedAt: row.emailUnsubscribedAt,
      };

const prefsColumns = {
  emailSchedule: notificationPrefs.emailSchedule,
  digestHour: notificationPrefs.digestHour,
  pausedUntil: notificationPrefs.pausedUntil,
  emailUnsubscribedAt: notificationPrefs.emailUnsubscribedAt,
};

export class EmailPacingRepository {
  // ------------------------------------------------------------- the person

  async preferences(tx: DbTransaction, userId: string): Promise<EmailPreferences> {
    const [row] = await tx
      .select(prefsColumns)
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId))
      .limit(1);

    return toPreferences(row);
  }

  async recipient(tx: DbTransaction, userId: string): Promise<Recipient | undefined> {
    const [row] = await tx
      .select({ name: users.name, email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row;
  }

  /**
   * The brand's name for the subject, and its time zone for times and the
   * daily digest's hour. A person's own time zone arrives with M14-12's
   * `users.time_zone`; until then the brand's stands in for everyone in it.
   */
  async brand(
    tx: DbTransaction,
    brandId: string,
  ): Promise<{ name: string; timeZone: string } | undefined> {
    const [row] = await tx
      .select({ name: brands.name, timeZone: brands.timezone })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return row;
  }

  // ---------------------------------------------------------------- pacing

  /** Takes the person's pacing lock, creating the row on first use. */
  async lockPacing(tx: DbTransaction, brandId: string, userId: string): Promise<PacingState> {
    await tx.insert(notificationEmailPacing).values({ brandId, userId }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(notificationEmailPacing)
      .where(
        and(
          eq(notificationEmailPacing.brandId, brandId),
          eq(notificationEmailPacing.userId, userId),
        ),
      )
      .for('update');
    /* c8 ignore next 3 -- the insert above guarantees the row. */
    if (row === undefined) {
      throw new Error('The pacing row vanished under its own lock.');
    }

    return {
      step: row.step,
      nextAllowedAt: row.nextAllowedAt,
      quietSince: row.quietSince,
      hourWindowStart: row.hourWindowStart,
      sentInHour: row.sentInHour,
      dayWindowStart: row.dayWindowStart,
      sentInDay: row.sentInDay,
      urgentSentInDay: row.urgentSentInDay,
      lastUrgentAt: row.lastUrgentAt,
    };
  }

  async savePacing(
    tx: DbTransaction,
    brandId: string,
    userId: string,
    state: PacingState,
  ): Promise<void> {
    await tx
      .update(notificationEmailPacing)
      .set({ ...state })
      .where(
        and(
          eq(notificationEmailPacing.brandId, brandId),
          eq(notificationEmailPacing.userId, userId),
        ),
      );
  }

  // ----------------------------------------------------------------- rows

  async scheduleFacts(
    tx: DbTransaction,
    notificationId: string,
  ): Promise<ScheduleFacts | undefined> {
    const [row] = await tx
      .select({
        id: notifications.id,
        userId: notifications.userId,
        kind: notifications.kind,
        emailState: notifications.emailState,
        emailBatchId: notifications.emailBatchId,
        email: notifications.email,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .limit(1);

    return row;
  }

  /** 1.0 claimed this receipt in the send transaction, so absence proves no send. */
  async recoverLegacy(tx: DbTransaction, row: ScheduleFacts, now: Date): Promise<boolean> {
    const [receipt] = await tx
      .select({ key: jobReceipts.key })
      .from(jobReceipts)
      .where(eq(jobReceipts.key, `notify.email:${row.id}`))
      .limit(1);
    if (
      !row.email ||
      row.createdAt.getTime() < now.getTime() - 86_400_000 ||
      receipt !== undefined
    ) {
      return false;
    }
    await tx
      .update(notifications)
      .set({ emailState: 'pending' })
      .where(and(eq(notifications.id, row.id), isNull(notifications.emailState)));
    return true;
  }

  async markRows(
    tx: DbTransaction,
    ids: readonly string[],
    state: EmailState,
    at: Date | null = null,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await tx
      .update(notifications)
      .set({ emailState: state, ...(at === null ? {} : { emailedAt: at }) })
      .where(and(inArray(notifications.id, [...ids]), eq(notifications.emailState, 'pending')));
  }

  /** One person's pending rows in the brand that no batch holds, oldest first. */
  async unbatchedRowIds(tx: DbTransaction, brandId: string, userId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.brandId, brandId),
          eq(notifications.userId, userId),
          eq(notifications.emailState, 'pending'),
          isNull(notifications.emailBatchId),
        ),
      )
      .orderBy(asc(notifications.createdAt), asc(notifications.id));

    return rows.map((row) => row.id);
  }

  /** Everyone with pending rows no batch holds, and their email choices. */
  async unbatchedRecipients(
    tx: DbTransaction,
    brandId: string,
  ): Promise<{ userId: string; preferences: EmailPreferences }[]> {
    const rows = await tx
      .selectDistinct({
        userId: notifications.userId,
        emailSchedule: notificationPrefs.emailSchedule,
        digestHour: notificationPrefs.digestHour,
        pausedUntil: notificationPrefs.pausedUntil,
        emailUnsubscribedAt: notificationPrefs.emailUnsubscribedAt,
      })
      .from(notifications)
      .leftJoin(notificationPrefs, eq(notificationPrefs.userId, notifications.userId))
      .where(
        and(
          eq(notifications.brandId, brandId),
          eq(notifications.emailState, 'pending'),
          isNull(notifications.emailBatchId),
        ),
      )
      .orderBy(asc(notifications.userId));

    return rows.map(({ userId, emailSchedule, digestHour, pausedUntil, emailUnsubscribedAt }) => ({
      userId,
      preferences: toPreferences(
        emailSchedule === null || digestHour === null
          ? undefined
          : { emailSchedule, digestHour, pausedUntil, emailUnsubscribedAt },
      ),
    }));
  }

  /**
   * Pending rows no batch holds whose owner is not on a digest: what a lost
   * `notify.email_schedule` job leaves behind, for the rebuild.
   */
  async orphanRowIds(tx: DbTransaction, brandId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .leftJoin(notificationPrefs, eq(notificationPrefs.userId, notifications.userId))
      .where(
        and(
          eq(notifications.brandId, brandId),
          eq(notifications.emailState, 'pending'),
          isNull(notifications.emailBatchId),
          sql`coalesce(${notificationPrefs.emailSchedule}, 'immediate') NOT IN ('hourly', 'daily')`,
        ),
      )
      .orderBy(asc(notifications.userId), asc(notifications.createdAt), asc(notifications.id));

    return rows.map((row) => row.id);
  }

  // -------------------------------------------------------------- batches

  async lockBatch(tx: DbTransaction, batchId: string): Promise<BatchRow | undefined> {
    const [row] = await tx
      .select(batchColumns)
      .from(notificationEmailBatches)
      .where(eq(notificationEmailBatches.id, batchId))
      .for('update');

    return row;
  }

  async batchOwner(tx: DbTransaction, batchId: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ userId: notificationEmailBatches.userId })
      .from(notificationEmailBatches)
      .where(eq(notificationEmailBatches.id, batchId))
      .limit(1);

    return row?.userId;
  }

  async pendingBatch(
    tx: DbTransaction,
    brandId: string,
    userId: string,
    kind: BatchKind,
  ): Promise<BatchRow | undefined> {
    const [row] = await tx
      .select(batchColumns)
      .from(notificationEmailBatches)
      .where(
        and(
          eq(notificationEmailBatches.brandId, brandId),
          eq(notificationEmailBatches.userId, userId),
          eq(notificationEmailBatches.kind, kind),
          eq(notificationEmailBatches.status, 'pending'),
        ),
      )
      .limit(1)
      .for('update');

    return row;
  }

  async openBatch(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly userId: string;
      readonly kind: BatchKind;
      readonly scheduledFor: Date;
      readonly urgent: boolean;
      /** Creation time from the engine's clock. */
      readonly createdAt: Date;
      readonly digestTickAt?: Date;
    },
  ): Promise<BatchRow> {
    const [row] = await tx.insert(notificationEmailBatches).values(values).returning(batchColumns);
    /* c8 ignore next 3 -- an insert always returns its row. */
    if (row === undefined) {
      throw new Error('The batch insert returned no row.');
    }

    return row;
  }

  async updateBatch(
    tx: DbTransaction,
    batchId: string,
    patch: Partial<{
      scheduledFor: Date;
      urgent: boolean;
      heldSince: Date | null;
      seenOnlineAt: Date | null;
      status: 'pending' | 'sent' | 'empty' | 'failed';
      sendFailures: number;
      sentAt: Date;
      itemCount: number;
    }>,
  ): Promise<void> {
    await tx
      .update(notificationEmailBatches)
      .set(patch)
      .where(eq(notificationEmailBatches.id, batchId));
  }

  async attach(
    tx: DbTransaction,
    batchId: string,
    notificationIds: readonly string[],
  ): Promise<void> {
    if (notificationIds.length === 0) {
      return;
    }
    const attached = await tx
      .update(notifications)
      .set({ emailBatchId: batchId })
      .where(
        and(
          inArray(notifications.id, [...notificationIds]),
          eq(notifications.emailState, 'pending'),
        ),
      )
      .returning({ id: notifications.id });
    await tx
      .update(notificationEmailBatches)
      .set({ itemCount: sql`${notificationEmailBatches.itemCount} + ${attached.length}` })
      .where(eq(notificationEmailBatches.id, batchId));
  }

  /** Lets a batch's pending rows go back to waiting for a digest. */
  async detach(tx: DbTransaction, batchId: string): Promise<void> {
    await tx
      .update(notifications)
      .set({ emailBatchId: null })
      .where(and(eq(notifications.emailBatchId, batchId), eq(notifications.emailState, 'pending')));
  }

  async pendingBatches(tx: DbTransaction, brandId: string): Promise<BatchRow[]> {
    return tx
      .select(batchColumns)
      .from(notificationEmailBatches)
      .where(
        and(
          eq(notificationEmailBatches.brandId, brandId),
          eq(notificationEmailBatches.status, 'pending'),
        ),
      )
      .orderBy(asc(notificationEmailBatches.scheduledFor));
  }

  /** Guard repeated local hours by the tick represented, even if its job ran late. */
  async dailyOpenedSince(
    tx: DbTransaction,
    brandId: string,
    userId: string,
    since: Date,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: notificationEmailBatches.id })
      .from(notificationEmailBatches)
      .where(
        and(
          eq(notificationEmailBatches.brandId, brandId),
          eq(notificationEmailBatches.userId, userId),
          eq(notificationEmailBatches.kind, 'daily'),
          notInArray(notificationEmailBatches.status, ['empty']),
          gte(notificationEmailBatches.digestTickAt, since),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * The rows of a batch still to decide, with what the re-check and the email
   * need. The ticket is joined only while it exists; the worker's transaction
   * sees every department, so scope is decided by the re-check, not here.
   */
  async batchItems(tx: DbTransaction, batchId: string): Promise<BatchItemRow[]> {
    const rows = await tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        ticketId: notifications.ticketId,
        reference,
        subject: tickets.subject,
        ticketDepartmentId: tickets.departmentId,
        contactName: contacts.name,
        actorName: sql<
          string | null
        >`(SELECT u.name FROM ${users} u WHERE u.id = ${notifications.actorId})`,
        detail: notifications.detail,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
        email: notifications.email,
      })
      .from(notifications)
      .leftJoin(tickets, and(eq(tickets.id, notifications.ticketId), isNull(tickets.deletedAt)))
      .leftJoin(contacts, eq(contacts.id, tickets.contactId))
      .where(and(eq(notifications.emailBatchId, batchId), eq(notifications.emailState, 'pending')))
      .orderBy(asc(notifications.createdAt), asc(notifications.id));

    return rows.map((row) => {
      const detail = notificationDetailSchema.safeParse(row.detail);
      return {
        ...row,
        reference: row.reference ?? '',
        subject: row.subject ?? '',
        detail: detail.success ? detail.data : {},
        // M14-03 stores the operation; folding on it is deferred to M14-04.
        bulkOperationId: null,
      };
    });
  }
}
