import type { EmailMessage, EmailSender } from '@helpdock/channels';
import type { DbTransaction } from '@helpdock/db';
import {
  claimReceipt,
  idempotencyKeyFor,
  type JobLogger,
  notifyEmailBatchJob,
} from '@helpdock/jobs';
import type { PresenceStatus } from '@helpdock/schemas';
import { renderBatchEmail } from './batch-email.js';
import { groupBatch } from './email-batch-content.js';
import {
  afterArrival,
  afterSend,
  capped,
  isUrgent,
  type PacingConfig,
  type PacingState,
  plannedSendAt,
  presenceDecision,
  urgentSendAt,
} from './email-pacing.js';
import type { BatchItemRow, BatchRow, EmailPacingRepository } from './email-pacing.repository.js';
import { isEmailOff, isPaused, type RowVerdict, verdictFor } from './email-recheck.js';
import type { NotificationsRepository } from './notifications.repository.js';
import { renderStaffNotificationEmail } from './staff-email.js';

/**
 * M14-10's pacing engine (DOMAIN-RULES §20, ADR 0037): the four jobs' work,
 * each in one brand system transaction. It decides and writes; the caller
 * places the BullMQ jobs after the transaction commits, from what each method
 * returns, so a batch job never wakes to a batch that is not there yet. A
 * crash between the two leaves a pending batch without a job, which
 * `notify.email_rebuild` finds within the hour.
 *
 * ```
 * notification.created  →  schedule()  →  pending batch, sends at scheduled_for
 * scheduled_for         →  send()      →  re-check, render, send, mark; or "later"
 * top of the hour       →  digestTick()→  a digest batch per person whose time it is
 * boot, hourly          →  rebuild()   →  every pending batch placed again
 * ```
 */

/** Where a batch job should be: the caller adds or moves `notify.batch.<id>` to `at`. */
export interface Placement {
  readonly batchId: string;
  readonly at: Date;
}

export type SendOutcome =
  | { readonly kind: 'done'; readonly sent: boolean }
  | { readonly kind: 'later'; readonly at: Date };

/** Only render/SMTP failures consume a batch's failure budget, never database or Redis errors. */
export class NotificationEmailDeliveryError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Notification email delivery failed', { cause });
    this.name = 'NotificationEmailDeliveryError';
  }
}

const emailDelivery = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (cause) {
    throw new NotificationEmailDeliveryError(cause);
  }
};

export interface EmailEngineDeps {
  readonly repository: EmailPacingRepository;
  readonly notifications: NotificationsRepository;
  config(): Promise<PacingConfig>;
  /** The recipient's presence in the brand, from the staff sockets (DOMAIN-RULES §12). */
  presenceOf(brandId: string, userId: string): Promise<PresenceStatus>;
  /** The install's system sender, or null without SMTP settings. */
  systemSender(): Promise<EmailSender | null>;
  /** `APP_URL`, for links and the `Message-ID` domain. */
  readonly appUrl: string;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

/** A batch job that wakes this much before its time runs anyway rather than sleeping again. */
const EARLY_TOLERANCE_MS = 1_000;
/** A daily digest is not opened twice inside this window, which a repeated local hour would do. */
const DAILY_REPEAT_GUARD_MS = 20 * 3_600_000;

/** `Message-ID` of a batch: the same however often its job runs (DOMAIN-RULES §6). */
export const batchMessageId = (batchId: string, appUrl: string): string =>
  `<notify.batch.${batchId}@${new URL(appUrl).hostname}>`;

/** The local hour of `at` in `timeZone`, 0–23. */
export const localHour = (at: Date, timeZone: string): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(at),
  );

export class NotificationEmailEngine {
  readonly #deps: EmailEngineDeps;

  constructor(deps: EmailEngineDeps) {
    this.#deps = deps;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  // ------------------------------------------------------------- schedule

  /**
   * `notify.email_schedule`: one notification's email. Right away joins the
   * person's pending batch or opens one; a digest schedule leaves the row for
   * the tick; Off, an unsubscribe or a pause marks it skipped. A row already in
   * a batch answers that batch's placement, so a redelivery repairs a job a
   * crash lost rather than doing anything twice.
   */
  async schedule(
    tx: DbTransaction,
    brandId: string,
    notificationId: string,
  ): Promise<Placement | null> {
    const { repository } = this.#deps;
    const owner = (await repository.scheduleFacts(tx, notificationId))?.userId;
    if (owner === undefined) {
      return null;
    }
    // Read again under the lock: a concurrent delivery may have placed it meanwhile.
    const pacing = await repository.lockPacing(tx, brandId, owner);
    const row = await repository.scheduleFacts(tx, notificationId);
    if (row?.emailState === null) {
      if (!(await repository.recoverLegacy(tx, row, this.#now()))) {
        this.#deps.log.info(
          { notificationId },
          'Legacy notification email dropped: sent, disabled, or older than 24 hours.',
        );
        return null;
      }
    } else if (row?.emailState !== 'pending') {
      return null;
    }

    if (row.emailBatchId !== null) {
      const batch = await repository.lockBatch(tx, row.emailBatchId);
      return batch?.status === 'pending' ? { batchId: batch.id, at: batch.scheduledFor } : null;
    }

    const preferences = await repository.preferences(tx, row.userId);
    const now = this.#now();
    if (isEmailOff(preferences)) {
      await repository.markRows(tx, [row.id], 'skipped_off');
      return null;
    }
    if (isPaused(preferences, now)) {
      await repository.markRows(tx, [row.id], 'skipped_paused');
      return null;
    }
    if ((await this.#deps.systemSender()) === null) {
      await repository.markRows(tx, [row.id], 'skipped_unconfigured');
      return null;
    }
    if (preferences.schedule !== 'immediate') {
      return null;
    }

    const config = await this.#deps.config();
    const state = afterArrival(config, pacing, now);
    const urgentAt = isUrgent(row.kind) ? urgentSendAt(config, state, now) : null;
    const open = await repository.pendingBatch(tx, brandId, row.userId, 'immediate');
    let placement: Placement | null = null;
    let batchId: string;

    if (open === undefined) {
      const planned = plannedSendAt(config, state, now);
      const cut = urgentAt !== null && urgentAt < planned;
      const scheduledFor = cut ? urgentAt : planned;
      batchId = (
        await repository.openBatch(tx, {
          brandId,
          userId: row.userId,
          kind: 'immediate',
          scheduledFor,
          urgent: cut,
          createdAt: now,
        })
      ).id;
      placement = { batchId, at: scheduledFor };
    } else {
      batchId = open.id;
      if (urgentAt !== null && urgentAt < open.scheduledFor) {
        await repository.updateBatch(tx, batchId, { scheduledFor: urgentAt, urgent: true });
        placement = { batchId, at: urgentAt };
      }
    }

    await repository.attach(tx, batchId, [row.id]);
    await repository.savePacing(tx, brandId, row.userId, state);

    return placement;
  }

  // ----------------------------------------------------------------- send

  /** The time a still-pending batch is due, read fresh; null once it is settled or gone. */
  async dueAt(tx: DbTransaction, batchId: string): Promise<Date | null> {
    const batch = await this.#deps.repository.lockBatch(tx, batchId);
    return batch?.status === 'pending' ? batch.scheduledFor : null;
  }

  /**
   * `notify.email_batch`. Everything that can make the email wait is asked
   * before the receipt is claimed, and written, so "later" commits its
   * reason and the job moves itself; only a send claims the receipt.
   */
  async send(tx: DbTransaction, brandId: string, batchId: string): Promise<SendOutcome> {
    const { repository } = this.#deps;
    const userId = await repository.batchOwner(tx, batchId);
    if (userId === undefined) {
      return { kind: 'done', sent: false };
    }

    const pacing = await repository.lockPacing(tx, brandId, userId);
    const batch = await repository.lockBatch(tx, batchId);
    if (batch?.status !== 'pending') {
      return { kind: 'done', sent: false };
    }

    const now = this.#now();
    if (batch.scheduledFor.getTime() - now.getTime() > EARLY_TOLERANCE_MS) {
      return { kind: 'later', at: batch.scheduledFor };
    }

    const preferences = await repository.preferences(tx, userId);
    if (
      batch.kind === 'immediate' &&
      (preferences.schedule === 'hourly' || preferences.schedule === 'daily')
    ) {
      // They moved to a digest since: the rows wait for it instead.
      await repository.detach(tx, batch.id);
      await repository.updateBatch(tx, batch.id, { status: 'empty' });
      return { kind: 'done', sent: false };
    }

    const config = await this.#deps.config();
    const until = await this.#waitUntil(tx, { brandId, batch, pacing, config, now });
    if (until !== null) {
      return { kind: 'later', at: until };
    }

    const receipt = idempotencyKeyFor(notifyEmailBatchJob, { brandId, batchId }, batchId);
    if (!(await claimReceipt(tx, receipt))) {
      return { kind: 'done', sent: false };
    }

    const sent = await this.#recheckAndSend(tx, brandId, batch, now);
    if (sent) {
      const kind = batch.kind !== 'immediate' ? 'digest' : batch.urgent ? 'urgent' : 'paced';
      await repository.savePacing(tx, brandId, userId, afterSend(config, pacing, now, kind));
    }

    return { kind: 'done', sent };
  }

  /**
   * When a due batch must still wait, written onto the batch so the rebuild
   * places its job at the same time: a cap reached, or its recipient online
   * (Right away only). Null when it may go now.
   */
  async #waitUntil(
    tx: DbTransaction,
    {
      brandId,
      batch,
      pacing,
      config,
      now,
    }: {
      readonly brandId: string;
      readonly batch: BatchRow;
      readonly pacing: PacingState;
      readonly config: PacingConfig;
      readonly now: Date;
    },
  ): Promise<Date | null> {
    const { repository } = this.#deps;
    const allowed = capped(config, pacing, now);
    if (allowed > now) {
      await repository.updateBatch(tx, batch.id, { scheduledFor: allowed });
      return allowed;
    }
    if (batch.kind !== 'immediate') {
      return null;
    }

    const decision = presenceDecision(
      await this.#deps.presenceOf(brandId, batch.userId),
      { heldSince: batch.heldSince, seenOnlineAt: batch.seenOnlineAt },
      now,
    );
    if (decision.kind === 'send') {
      return null;
    }
    await repository.updateBatch(tx, batch.id, { ...decision.hold, scheduledFor: decision.until });

    return decision.until;
  }

  async #recheckAndSend(
    tx: DbTransaction,
    brandId: string,
    batch: BatchRow,
    now: Date,
  ): Promise<boolean> {
    const { repository, notifications, log } = this.#deps;
    const [items, members, preferences] = await Promise.all([
      repository.batchItems(tx, batch.id),
      notifications.members(tx, brandId),
      repository.preferences(tx, batch.userId),
    ]);
    const recipient = members.find((member) => member.userId === batch.userId);

    const verdicts = new Map<RowVerdict, BatchItemRow[]>();
    for (const item of items) {
      const verdict = verdictFor({
        row: item,
        recipient,
        preferences,
        now,
      });
      verdicts.set(verdict, [...(verdicts.get(verdict) ?? []), item]);
    }
    for (const [verdict, rows] of verdicts) {
      if (verdict !== 'send') {
        await repository.markRows(tx, ids(rows), verdict);
      }
    }

    const sendable = verdicts.get('send') ?? [];
    if (sendable.length === 0) {
      await repository.updateBatch(tx, batch.id, { status: 'empty' });
      return false;
    }

    const sender = await this.#deps.systemSender();
    if (sender === null) {
      // As in 1.0: retrying cannot make an operator configure SMTP, so the
      // rows are settled as unconfigured rather than kept.
      log.warn(
        { job: notifyEmailBatchJob.name, batchId: batch.id },
        'Notification email not sent: this install has no SMTP settings.',
      );
      await repository.markRows(tx, ids(sendable), 'skipped_unconfigured');
      await repository.updateBatch(tx, batch.id, { status: 'empty' });
      return false;
    }

    const message = await this.#render(tx, brandId, batch, sendable, now);
    if (message === null) {
      await repository.markRows(tx, ids(sendable), 'skipped_scope');
      await repository.updateBatch(tx, batch.id, { status: 'empty' });
      return false;
    }

    await emailDelivery(() =>
      sender.send({ ...message, messageId: batchMessageId(batch.id, this.#deps.appUrl) }),
    );
    await repository.markRows(tx, ids(sendable), 'sent', now);
    await repository.updateBatch(tx, batch.id, {
      status: 'sent',
      sentAt: now,
      itemCount: sendable.length,
    });

    return true;
  }

  /** One row of a Right away batch is 1.0's email; anything else is a batch or a digest. */
  async #render(
    tx: DbTransaction,
    brandId: string,
    batch: BatchRow,
    items: readonly BatchItemRow[],
    now: Date,
  ): Promise<EmailMessage | null> {
    const { repository, appUrl } = this.#deps;
    const [only] = items;
    if (batch.kind === 'immediate' && items.length === 1 && only !== undefined) {
      return this.#renderSingle(tx, only.id);
    }

    const [recipient, brand] = await Promise.all([
      repository.recipient(tx, batch.userId),
      repository.brand(tx, brandId),
    ]);
    const content = groupBatch(items, batch.kind === 'immediate' ? 'batch' : 'digest');
    if (recipient === undefined || brand === undefined || content === null) {
      return null;
    }

    return emailDelivery(() =>
      renderBatchEmail({
        kind: batch.kind,
        locale: recipient.locale,
        timeZone: brand.timeZone,
        to: { address: recipient.email, name: recipient.name },
        brandName: brand.name,
        content,
        appUrl,
        now,
      }),
    );
  }

  async #renderSingle(tx: DbTransaction, notificationId: string): Promise<EmailMessage | null> {
    const { notifications, appUrl } = this.#deps;
    const notification = await notifications.delivery(tx, notificationId);
    const ticket =
      notification === undefined
        ? undefined
        : await notifications.ticket(tx, notification.ticketId);
    if (notification === undefined || ticket === undefined) {
      return null;
    }

    const [assigneeName, message] = await Promise.all([
      ticket.assigneeId === null
        ? Promise.resolve(null)
        : notifications.userName(tx, ticket.assigneeId),
      notification.messageId === null
        ? Promise.resolve(undefined)
        : notifications.message(tx, notification.messageId),
    ]);
    const locale = notification.userLocale;

    return emailDelivery(() =>
      renderStaffNotificationEmail({
        kind: notification.kind,
        locale,
        to: { address: notification.userEmail, name: notification.userName },
        recipientId: notification.userId,
        ticket: {
          id: ticket.id,
          reference: ticket.reference,
          subject: ticket.subject,
          departmentName:
            locale === 'ar'
              ? (ticket.departmentNameAr ?? ticket.departmentName)
              : ticket.departmentName,
          priority: ticket.priority,
          contactName: ticket.contactName,
          assigneeId: ticket.assigneeId,
          assigneeName: assigneeName ?? null,
        },
        actorName: notification.actorName,
        messageText: message?.bodyText ?? null,
        detail: notification.detail,
        appUrl,
      }),
    );
  }

  // --------------------------------------------------------------- digest

  /**
   * `notify.digest.tick` for one brand and one hour: a digest batch for
   * every person on the hourly digest, and for every person on the daily one
   * whose hour it is in their time zone. People who turned email off or
   * paused since their rows were made have those rows marked skipped here,
   * so nothing waits for a digest that will never come.
   */
  async digestTick(tx: DbTransaction, brandId: string, hour: Date): Promise<Placement[]> {
    const { repository } = this.#deps;
    const brand = await repository.brand(tx, brandId);
    if (brand === undefined) {
      return [];
    }

    const now = this.#now();
    const config = await this.#deps.config();
    const placements: Placement[] = [];

    for (const { userId, preferences } of await repository.unbatchedRecipients(tx, brandId)) {
      const off = isEmailOff(preferences);
      const paused = isPaused(preferences, now);
      if (!off && !paused && preferences.schedule === 'immediate') {
        continue;
      }

      const pacing = await repository.lockPacing(tx, brandId, userId);
      const rowIds = await repository.unbatchedRowIds(tx, brandId, userId);
      if (off || paused) {
        await repository.markRows(tx, rowIds, off ? 'skipped_off' : 'skipped_paused');
        continue;
      }

      const kind = preferences.schedule === 'hourly' ? 'hourly' : 'daily';
      if (
        kind === 'daily' &&
        (localHour(hour, brand.timeZone) !== preferences.digestHour ||
          (await repository.dailyOpenedSince(
            tx,
            brandId,
            userId,
            new Date(hour.getTime() - DAILY_REPEAT_GUARD_MS),
          )))
      ) {
        continue;
      }
      if (capped(config, pacing, now) > now) {
        // Over a cap: the rows stay for the next tick.
        continue;
      }

      const batch =
        (await repository.pendingBatch(tx, brandId, userId, kind)) ??
        (await repository.openBatch(tx, {
          brandId,
          userId,
          kind,
          scheduledFor: now,
          digestTickAt: hour,
          urgent: false,
          createdAt: now,
        }));
      await repository.attach(tx, batch.id, rowIds);
      placements.push({ batchId: batch.id, at: now });
    }

    return placements;
  }

  /** Runs in a fresh transaction after a failed send rolled back, including its receipt. */
  async recordFailure(tx: DbTransaction, brandId: string, batchId: string): Promise<boolean> {
    const { repository } = this.#deps;
    const userId = await repository.batchOwner(tx, batchId);
    if (userId === undefined) return false;
    await repository.lockPacing(tx, brandId, userId);
    const batch = await repository.lockBatch(tx, batchId);
    if (batch?.status !== 'pending') return false;
    const sendFailures = batch.sendFailures + 1;
    const failed = sendFailures >= 5;
    await repository.updateBatch(tx, batchId, {
      sendFailures,
      ...(failed ? { status: 'failed' } : {}),
    });
    if (failed) {
      await repository.markRows(
        tx,
        ids(await repository.batchItems(tx, batchId)),
        'skipped_failed',
      );
    }
    return failed;
  }

  // -------------------------------------------------------------- rebuild

  /**
   * `notify.email_rebuild`: schedules every pending row that no batch holds
   * and whose owner is not on a digest, then answers every pending batch, so
   * the caller can place each job again after Redis lost them.
   */
  async rebuild(tx: DbTransaction, brandId: string): Promise<Placement[]> {
    const { repository } = this.#deps;
    for (const notificationId of await repository.orphanRowIds(tx, brandId)) {
      await this.schedule(tx, brandId, notificationId);
    }

    return (await repository.pendingBatches(tx, brandId)).map((batch) => ({
      batchId: batch.id,
      at: batch.scheduledFor,
    }));
  }
}

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id);
