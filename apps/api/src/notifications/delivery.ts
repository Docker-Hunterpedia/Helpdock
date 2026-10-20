import type { Db } from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import {
  createJobProcessor,
  type JobHandler,
  type JobLogger,
  type NotifyPushPayload,
  notifyPushJob,
  silentLogger,
} from '@helpdock/jobs';
import { notificationDetailSchema } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import type { DeliveryFacts, NotificationsRepository } from './notifications.repository.js';
import type { PushPayload, PushSender, VapidKeys } from './push.js';

/**
 * The `notify` queue's consumers: one push per notification per browser
 * (M3-07), and M14-10's paced email jobs, which `email-jobs.ts` builds. Push
 * runs in the brand's system transaction under a receipt keyed by what it
 * sends, so a redelivered job sends nothing a second time (DOMAIN-RULES §6).
 *
 * Push is not sure its channel exists: it needs the VAPID key pair, and an
 * install may have none. A job that finds it missing logs that and finishes,
 * because retrying it cannot make an operator configure push.
 */

/** What push reads from the install's settings, as late as possible. */
export interface DeliverySettings {
  vapidKeys(): Promise<VapidKeys | null>;
}

export interface DeliveryWorkerDeps {
  readonly repository: NotificationsRepository;
  readonly settings: DeliverySettings;
  readonly push: PushSender;
}

/** A processor per job name, as `createEmailJobProcessors` returns them. */
export type JobProcessors = Readonly<Record<string, (job: Job, token?: string) => Promise<void>>>;

const detailOf = (notification: DeliveryFacts) => {
  const parsed = notificationDetailSchema.safeParse(notification.detail);
  return parsed.success ? parsed.data : {};
};

/**
 * What the browser shows: the email's heading as the title and the ticket's
 * subject under it, in the recipient's language. A test push says it is one.
 */
export const pushPayloadFor = (
  notification: DeliveryFacts,
  ticket: {
    readonly reference: string;
    readonly subject: string;
    readonly contactName: string | null;
  },
): PushPayload => {
  const locale: Locale = notification.userLocale;
  const t = createI18n({ lng: locale }).getFixedT(locale, 'email', 'staffNotification');
  const detail = detailOf(notification);

  return {
    title: t(`heading.${notification.kind}`, {
      reference: ticket.reference,
      contact: ticket.contactName ?? t('aContact'),
      actor: notification.actorName ?? t('someone'),
      clock: t(`clock.${detail.clock ?? 'unknown'}`),
    }),
    body: ticket.subject,
    url: `/tickets/${encodeURIComponent(notification.ticketId)}`,
    tag: notification.id,
  };
};

export const testPushPayload = (locale: Locale, testId: string): PushPayload => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'email', 'staffNotification');

  return {
    title: t('push.testTitle'),
    body: t('push.testBody'),
    url: '/me/notifications',
    tag: testId,
  };
};

export const createPushHandler =
  ({ repository, settings, push }: DeliveryWorkerDeps): JobHandler<NotifyPushPayload> =>
  async ({ payload, tx, log }) => {
    const subscription = await repository.subscription(tx, payload.subscriptionId);
    if (subscription === undefined) {
      return;
    }

    const vapid = await settings.vapidKeys();
    if (vapid === null) {
      log.warn(
        { job: notifyPushJob.name, subscriptionId: subscription.id },
        'Push not sent: this install has no VAPID key pair.',
      );
      return;
    }

    const content = await pushContent(repository, tx, payload, subscription.userId);
    if (content === null) {
      return;
    }

    const outcome = await push.send(subscription, content, vapid);
    if (outcome === 'gone') {
      // ADR 0002: a 404 or 410 means the browser dropped the subscription.
      await repository.deleteSubscription(tx, subscription.id);
      log.info({ subscriptionId: subscription.id }, 'push subscription gone; deleted');
    }
  };

const pushContent = async (
  repository: NotificationsRepository,
  tx: Parameters<NotificationsRepository['delivery']>[0],
  payload: NotifyPushPayload,
  subscriberId: string,
): Promise<PushPayload | null> => {
  if (payload.notificationId === undefined) {
    const account = await repository.account(tx, subscriberId);
    return account === undefined ? null : testPushPayload(account.locale, payload.testId ?? '');
  }

  const notification = await repository.delivery(tx, payload.notificationId);
  // The browser may have changed hands since the job was queued; it only ever
  // shows its current owner's notifications.
  if (
    notification === undefined ||
    !notification.push ||
    notification.userDeactivated ||
    notification.userId !== subscriberId
  ) {
    return null;
  }

  const ticket = await repository.ticket(tx, notification.ticketId);
  return ticket === undefined ? null : pushPayloadFor(notification, ticket);
};

/**
 * One processor for the `notify` queue, which carries several job names:
 * BullMQ routes by queue, so the name decides which handler runs.
 */
export const createNotifyProcessor = (
  deps: DeliveryWorkerDeps,
  {
    db,
    log = silentLogger,
    email = {},
  }: {
    readonly db: Db;
    readonly log?: JobLogger | undefined;
    /** M14-10's email jobs by name. */
    readonly email?: JobProcessors;
  },
): ((job: Job, token?: string) => Promise<void>) => {
  const pushJob = createJobProcessor(notifyPushJob, createPushHandler(deps), { db, log });

  return async (job, token) => {
    if (job.name === notifyPushJob.name) {
      return pushJob(job);
    }
    const emailJob = email[job.name];
    if (emailJob === undefined) {
      throw new UnrecoverableError(`The notify queue does not handle ${job.name}.`);
    }

    return emailJob(job, token);
  };
};
