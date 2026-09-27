import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import {
  excerptOf,
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_WINDOW_DAYS,
  type NotificationList,
  type NotificationListQuery,
  type NotificationPreferences,
  type NotificationPreferencesView,
  type NotificationView,
  notificationDetailSchema,
  type PushSubscriptionCreate,
  type PushSubscriptionView,
  pushSubscriptionCreateSchema,
  resolveNotificationPreferences,
} from '@helpdock/schemas';
import { ConflictException, NotFoundException } from '@nestjs/common';
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

const DAY_MS = 86_400_000;

export class NotificationsService {
  readonly #repository: NotificationsRepository;
  readonly #push: PushAvailability;
  readonly #now: () => Date;

  constructor(
    repository: NotificationsRepository,
    push: PushAvailability,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#push = push;
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

  // ------------------------------------------------------------ preferences

  async preferences(tx: DbTransaction, userId: string): Promise<NotificationPreferencesView> {
    const [stored, account, publicKey, subscriptions] = await Promise.all([
      this.#repository.storedPreferences(tx, userId),
      this.#repository.account(tx, userId),
      this.#push.vapidPublicKey(),
      this.#repository.subscriptionsOf(tx, userId),
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
    };
  }

  async updatePreferences(
    tx: DbTransaction,
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferencesView> {
    await this.#repository.savePreferences(tx, userId, preferences);

    return this.preferences(tx, userId);
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
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
  };
};

const toSubscriptionView = (row: SubscriptionRow): PushSubscriptionView => ({
  id: row.id,
  label: row.label,
  createdAt: row.createdAt.toISOString(),
});
