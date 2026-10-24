import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import {
  excerptOf,
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_PAUSE_MAX_DAYS,
  NOTIFICATION_WINDOW_DAYS,
  type NotificationList,
  type NotificationListQuery,
  type NotificationPreferencesUpdate,
  type NotificationPreferencesView,
  type NotificationView,
  notificationDetailSchema,
  type PushSubscriptionCreate,
  type PushSubscriptionView,
  pushSubscriptionCreateSchema,
  resolveNotificationPreferences,
} from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { NOTIFICATION_EVENTS } from './notification-events.js';
import type {
  NotificationsRepository,
  PanelRow,
  SubscriptionRow,
} from './notifications.repository.js';

/**
 * The request half of M3-07: the bell's panel, marking things read, the
 * Notifications tab of Your account, and the browsers push is turned on in.
 *
 * Every method acts on the person making the request and takes no user id from
 * the request: there is no parameter that could name somebody else, and the
 * owner policy on `notifications` would refuse it if there were.
 */

/** A staff member in one brand, as the brand routes see them. */
export interface PanelContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly userId: string;
}

/** What the preferences page needs to know about the install. */
export interface PushAvailability {
  vapidPublicKey(): Promise<string | null>;
}

/** Whether the install can send notification email at all (its `smtp.*` settings). */
export interface EmailAvailability {
  smtpConfigured(): Promise<boolean>;
}

/** The budget on "Send me a test email", per person. */
export interface TestEmailLimiter {
  /** True when one more is allowed, and counts it. */
  allow(userId: string): Promise<boolean>;
}

const DAY_MS = 86_400_000;

export const TEST_EMAIL_LIMIT_PER_HOUR = 5;

export class NotificationsService {
  readonly #repository: NotificationsRepository;
  readonly #push: PushAvailability & EmailAvailability;
  readonly #testEmails: TestEmailLimiter;
  readonly #now: () => Date;

  constructor(
    repository: NotificationsRepository,
    push: PushAvailability & EmailAvailability,
    testEmails: TestEmailLimiter,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#push = push;
    this.#testEmails = testEmails;
    this.#now = now;
  }

  // ------------------------------------------------------------------ panel

  async list(context: PanelContext, query: NotificationListQuery): Promise<NotificationList> {
    const since = new Date(this.#now().getTime() - NOTIFICATION_WINDOW_DAYS * DAY_MS);
    const [rows, unreadCount] = await Promise.all([
      this.#repository.panel(context.tx, {
        brandId: context.brandId,
        userId: context.userId,
        unreadOnly: query.filter === 'unread',
        since,
        limit: NOTIFICATION_PAGE_SIZE,
      }),
      this.#repository.unreadCount(context.tx, {
        brandId: context.brandId,
        userId: context.userId,
        since,
      }),
    ]);

    return { items: rows.map(toView), unreadCount };
  }

  async markRead(context: PanelContext, notificationId: string): Promise<void> {
    if (
      !(await this.#repository.markRead(context.tx, context.userId, notificationId, this.#now()))
    ) {
      throw new NotFoundException('No such notification');
    }
  }

  async markAllRead(context: PanelContext): Promise<void> {
    await this.#repository.markAllRead(context.tx, {
      brandId: context.brandId,
      userId: context.userId,
      at: this.#now(),
    });
  }

  /**
   * "Send a test" on the Notifications tab. Through the outbox like every
   * other push, so the button proves the path a real notification takes.
   */
  async testPush(context: PanelContext, subscriptionId: string): Promise<void> {
    if ((await this.#push.vapidPublicKey()) === null) {
      throw new ConflictException('Browser push is not set up on this install');
    }

    const subscription = await this.#repository.subscription(context.tx, subscriptionId);
    if (subscription?.userId !== context.userId) {
      throw new NotFoundException('No such browser');
    }

    await enqueueOutbox(context.tx, {
      brandId: context.brandId,
      event: NOTIFICATION_EVENTS.pushTest,
      payload: { userId: context.userId, subscriptionId },
    });
  }

  /**
   * "Send me a test email" (M14-11): through the outbox like every other
   * email, to the address of the person asking and never to one they name,
   * at most {@link TEST_EMAIL_LIMIT_PER_HOUR} an hour.
   */
  async testEmail(context: PanelContext): Promise<void> {
    if (!(await this.#push.smtpConfigured())) {
      throw new ConflictException('This install cannot send email: no SMTP settings');
    }
    if (!(await this.#testEmails.allow(context.userId))) {
      throw new HttpException('Too many test emails', HttpStatus.TOO_MANY_REQUESTS);
    }

    await enqueueOutbox(context.tx, {
      brandId: context.brandId,
      event: NOTIFICATION_EVENTS.emailTest,
      payload: { userId: context.userId },
    });
  }

  // ------------------------------------------------------------ preferences

  async preferences(
    tx: DbTransaction,
    userId: string,
    brandId: string | null = null,
  ): Promise<NotificationPreferencesView> {
    const [stored, account, publicKey, subscriptions, emailDelivery, emailConfigured, zone] =
      await Promise.all([
        this.#repository.storedPreferences(tx, userId),
        this.#repository.account(tx, userId),
        this.#push.vapidPublicKey(),
        this.#repository.subscriptionsOf(tx, userId),
        this.#repository.emailDelivery(tx, userId),
        this.#push.smtpConfigured(),
        brandId === null ? Promise.resolve(undefined) : this.#repository.brandTimeZone(tx, brandId),
      ]);
    /* c8 ignore next 3 -- the guard has already proved the account exists. */
    if (account === undefined) {
      throw new NotFoundException('No such account');
    }

    return {
      preferences: resolveNotificationPreferences(stored),
      email: account.email,
      locale: account.locale,
      push: {
        configured: publicKey !== null,
        publicKey,
        subscriptions: subscriptions.map(toSubscriptionView),
      },
      emailDelivery,
      emailConfigured,
      // The person's own zone (M14-12), the current brand's until they choose one.
      digestTimeZone: account.timeZone ?? zone ?? null,
    };
  }

  /**
   * Saves whichever parts the update names. A pause must end in the future and
   * within a year; `pausedUntil: null` resumes (DOMAIN-RULES §20).
   */
  async updatePreferences(
    tx: DbTransaction,
    userId: string,
    update: NotificationPreferencesUpdate,
    brandId: string | null = null,
  ): Promise<NotificationPreferencesView> {
    const pausedUntil =
      update.pausedUntil === undefined || update.pausedUntil === null
        ? update.pausedUntil
        : this.#pauseEnd(update.pausedUntil);
    await this.#repository.savePreferences(tx, userId, update.preferences, {
      emailSchedule: update.emailSchedule,
      digestHour: update.digestHour,
      pausedUntil,
      emailUnsubscribedAt: update.emailUnsubscribed === false ? null : undefined,
    });

    return this.preferences(tx, userId, brandId);
  }

  #pauseEnd(value: string): Date {
    const end = new Date(value);
    const now = this.#now().getTime();
    if (end.getTime() <= now || end.getTime() > now + NOTIFICATION_PAUSE_MAX_DAYS * DAY_MS) {
      throw new BadRequestException(
        `A pause must end in the future and within ${NOTIFICATION_PAUSE_MAX_DAYS} days`,
      );
    }

    return end;
  }

  async addSubscription(
    tx: DbTransaction,
    userId: string,
    request: PushSubscriptionCreate,
  ): Promise<PushSubscriptionView> {
    const parsed = pushSubscriptionCreateSchema.parse(request);
    const row = await this.#repository.upsertSubscription(tx, {
      userId,
      endpoint: parsed.endpoint,
      p256dh: parsed.keys.p256dh,
      auth: parsed.keys.auth,
      label: parsed.label,
    });

    return toSubscriptionView(row);
  }

  async removeSubscription(
    tx: DbTransaction,
    userId: string,
    subscriptionId: string,
  ): Promise<void> {
    if (!(await this.#repository.deleteSubscription(tx, subscriptionId, userId))) {
      throw new NotFoundException('No such browser');
    }
  }
}

const toView = (row: PanelRow): NotificationView => {
  const detail = notificationDetailSchema.safeParse(row.detail);

  return {
    id: row.id,
    kind: row.kind,
    ticketId: row.ticketId,
    ticketReference: row.reference,
    subject: row.subject,
    departmentName: row.departmentName,
    departmentNameAr: row.departmentNameAr,
    actorName: row.actorName,
    excerpt: row.bodyText === null ? null : excerptOf(row.bodyText),
    messageChannel: row.messageChannel,
    detail: detail.success ? detail.data : {},
    bulkOperationId: row.bulkOperationId,
    bulkOperationCount: row.bulkOperationCount,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
  };
};

const toSubscriptionView = (row: SubscriptionRow): PushSubscriptionView => ({
  id: row.id,
  label: row.label,
  createdAt: row.createdAt.toISOString(),
});
