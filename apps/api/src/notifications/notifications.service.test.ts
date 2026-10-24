import type { DbTransaction } from '@helpdock/db';
import { NOTIFICATION_PREFERENCE_DEFAULTS, type NotificationPreferences } from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  NotificationsRepository,
  PanelRow,
  SubscriptionRow,
} from './notifications.repository.js';
import { NotificationsService, type PanelContext } from './notifications.service.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const ME = '0199f4b2-1111-7000-8000-000000000002';
const SUBSCRIPTION = '0199f4b2-8888-7000-8000-000000000001';
const NOW = new Date('2026-09-27T12:00:00.000Z');

const row: PanelRow = {
  id: '0199f4b2-7777-7000-8000-000000000001',
  kind: 'mentioned',
  ticketId: '0199f4b2-2222-7000-8000-0000000000aa',
  reference: 'HD-1041',
  subject: 'Cannot log in',
  departmentName: 'Technical',
  departmentNameAr: null,
  actorName: 'Omar Nasser',
  bodyText: '@Lina can you confirm from finance?',
  messageChannel: 'manual',
  detail: { unexpected: true, clock: 'nonsense' },
  bulkOperationId: '0199f4b2-9999-7000-8000-000000000001',
  bulkOperationCount: 12,
  createdAt: new Date('2026-09-27T11:46:00.000Z'),
  readAt: null,
};

const subscription: SubscriptionRow = {
  id: SUBSCRIPTION,
  userId: ME,
  endpoint: 'https://push.example.com/a',
  p256dh: 'k',
  auth: 'a',
  label: 'Chrome on macOS',
  createdAt: new Date('2026-09-20T09:00:00.000Z'),
};

interface Calls {
  since?: Date;
  unreadOnly?: boolean;
  outbox: { event: string; payload: unknown }[];
  saved?: NotificationPreferences | undefined;
  email: Record<string, unknown>;
}

const service = ({
  vapid = 'public-key',
  marked = true,
  deleted = true,
  subscriptionOwner = ME,
  smtp = true,
  allowTestEmail = true,
  userZone = null,
}: {
  vapid?: string | null;
  marked?: boolean;
  deleted?: boolean;
  subscriptionOwner?: string;
  smtp?: boolean;
  allowTestEmail?: boolean;
  userZone?: string | null;
} = {}) => {
  const calls: Calls = { outbox: [], email: {} };
  const repository = {
    panel: async (_tx: DbTransaction, query: { since: Date; unreadOnly: boolean }) => {
      calls.since = query.since;
      calls.unreadOnly = query.unreadOnly;
      return [row];
    },
    unreadCount: async () => 3,
    markRead: async () => marked,
    markAllRead: async () => undefined,
    subscription: async () => ({ ...subscription, userId: subscriptionOwner }),
    storedPreferences: async () => calls.saved,
    savePreferences: async (
      _tx: DbTransaction,
      _user: string,
      saved: NotificationPreferences | undefined,
      email: Record<string, unknown>,
    ) => {
      calls.saved = saved;
      calls.email = email;
    },
    emailDelivery: async () => ({
      schedule: 'immediate' as const,
      digestHour: 8,
      pausedUntil: null,
      unsubscribedAt: null,
    }),
    brandTimeZone: async () => 'Asia/Riyadh',
    account: async () => ({
      email: 'lina@helpdock.test',
      locale: 'en' as const,
      timeZone: userZone,
    }),
    subscriptionsOf: async () => [subscription],
    upsertSubscription: async (
      _tx: DbTransaction,
      values: Omit<SubscriptionRow, 'id' | 'createdAt'>,
    ) => ({
      ...subscription,
      ...values,
    }),
    deleteSubscription: async () => deleted,
  } as unknown as NotificationsRepository;
  const tx = {
    insert: () => ({
      values: (values: { event: string; payload: unknown }) => {
        calls.outbox.push(values);
        return { returning: async () => [{ id: 'outbox-1' }] };
      },
    }),
  } as unknown as DbTransaction;
  const context: PanelContext = { tx, brandId: BRAND, userId: ME };

  return {
    calls,
    context,
    tx,
    notifications: new NotificationsService(
      repository,
      { vapidPublicKey: async () => vapid, smtpConfigured: async () => smtp },
      { allow: async () => allowTestEmail },
      () => NOW,
    ),
  };
};

describe('NotificationsService — the panel', () => {
  it('lists the last thirty days with an excerpt, and drops detail it does not know', async () => {
    const { notifications, context, calls } = service();

    const list = await notifications.list(context, { filter: 'unread' });

    expect(calls.since).toEqual(new Date('2026-08-28T12:00:00.000Z'));
    expect(calls.unreadOnly).toBe(true);
    expect(list).toEqual({
      unreadCount: 3,
      items: [
        {
          id: row.id,
          kind: 'mentioned',
          ticketId: row.ticketId,
          ticketReference: 'HD-1041',
          subject: 'Cannot log in',
          departmentName: 'Technical',
          departmentNameAr: null,
          actorName: 'Omar Nasser',
          excerpt: '@Lina can you confirm from finance?',
          messageChannel: 'manual',
          detail: {},
          bulkOperationId: '0199f4b2-9999-7000-8000-000000000001',
          bulkOperationCount: 12,
          createdAt: '2026-09-27T11:46:00.000Z',
          readAt: null,
        },
      ],
    });
  });

  it('answers 404 for a notification that is not the reader’s', async () => {
    const { notifications, context } = service({ marked: false });

    await expect(notifications.markRead(context, row.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('queues a test push through the outbox', async () => {
    const { notifications, context, calls } = service();

    await notifications.testPush(context, SUBSCRIPTION);

    expect(calls.outbox).toEqual([
      expect.objectContaining({
        brandId: BRAND,
        event: 'notification.push_test',
        payload: { userId: ME, subscriptionId: SUBSCRIPTION },
      }),
    ]);
  });

  it('refuses a test push on an install without keys, or to somebody else’s browser', async () => {
    await expect(
      service({ vapid: null }).notifications.testPush(service().context, SUBSCRIPTION),
    ).rejects.toBeInstanceOf(ConflictException);

    const other = service({ subscriptionOwner: 'someone-else' });
    await expect(other.notifications.testPush(other.context, SUBSCRIPTION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('NotificationsService — the test email', () => {
  it('queues one through the outbox for the person asking, naming no address', async () => {
    const { notifications, context, calls } = service();

    await notifications.testEmail(context);

    expect(calls.outbox).toEqual([
      expect.objectContaining({
        brandId: BRAND,
        event: 'notification.email_test',
        payload: { userId: ME },
      }),
    ]);
  });

  it('refuses on an install without SMTP, and past the hourly budget', async () => {
    const noSmtp = service({ smtp: false });
    await expect(noSmtp.notifications.testEmail(noSmtp.context)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const spent = service({ allowTestEmail: false });
    await expect(spent.notifications.testEmail(spent.context)).rejects.toMatchObject({
      status: 429,
    });
    expect(spent.calls.outbox).toEqual([]);
  });
});

describe('NotificationsService — preferences', () => {
  it('shows the defaults, the address, and that push is set up', async () => {
    const { notifications, tx } = service();

    expect(await notifications.preferences(tx, ME)).toEqual({
      preferences: NOTIFICATION_PREFERENCE_DEFAULTS,
      email: 'lina@helpdock.test',
      locale: 'en',
      push: {
        configured: true,
        publicKey: 'public-key',
        subscriptions: [
          { id: SUBSCRIPTION, label: 'Chrome on macOS', createdAt: '2026-09-20T09:00:00.000Z' },
        ],
      },
      emailDelivery: {
        schedule: 'immediate',
        digestHour: 8,
        pausedUntil: null,
        unsubscribedAt: null,
      },
      emailConfigured: true,
      digestTimeZone: null,
    });
  });

  it('says whether the install can send email at all, and which zone the digest hour is in', async () => {
    const { notifications, tx } = service({ smtp: false });

    expect(await notifications.preferences(tx, ME, BRAND)).toMatchObject({
      emailConfigured: false,
      digestTimeZone: 'Asia/Riyadh',
    });
  });

  it("reads the digest hour in the person's own zone when they have chosen one", async () => {
    const { notifications, tx } = service({ userZone: 'Europe/Berlin' });

    expect(await notifications.preferences(tx, ME, BRAND)).toMatchObject({
      digestTimeZone: 'Europe/Berlin',
    });
  });

  it('turns email back on after an unsubscribe by clearing it, and nothing else', async () => {
    const { notifications, tx, calls } = service();

    await notifications.updatePreferences(tx, ME, { emailUnsubscribed: false });

    expect(calls.saved).toBeUndefined();
    expect(calls.email).toMatchObject({
      emailUnsubscribedAt: null,
      resubscribedAt: expect.any(Date),
    });
  });

  it('does not ask for a resubscribe stamp on a save that is not "Turn email back on"', async () => {
    const { notifications, tx, calls } = service();

    await notifications.updatePreferences(tx, ME, { digestHour: 7 });

    expect(calls.email).toMatchObject({ resubscribedAt: undefined });
  });

  it('says push is not set up on an install without keys', async () => {
    const { notifications, tx } = service({ vapid: null });

    expect((await notifications.preferences(tx, ME)).push).toMatchObject({
      configured: false,
      publicKey: null,
    });
  });

  it('saves and reads back what was saved', async () => {
    const { notifications, tx } = service();
    const changed = {
      ...NOTIFICATION_PREFERENCE_DEFAULTS,
      replied: { inApp: true, email: true, push: false },
    };

    expect(
      (await notifications.updatePreferences(tx, ME, { preferences: changed })).preferences,
    ).toEqual(changed);
  });

  it('saves the email schedule alone, keeping the matrix it had (M14-10)', async () => {
    const { notifications, tx, calls } = service();

    await notifications.updatePreferences(tx, ME, { emailSchedule: 'daily', digestHour: 7 });

    expect(calls.saved).toBeUndefined();
    expect(calls.email).toEqual({ emailSchedule: 'daily', digestHour: 7, pausedUntil: undefined });
  });

  it('pauses until a time ahead, and resumes with null', async () => {
    const { notifications, tx, calls } = service();

    await notifications.updatePreferences(tx, ME, { pausedUntil: '2026-09-27T13:00:00.000Z' });
    expect(calls.email.pausedUntil).toEqual(new Date('2026-09-27T13:00:00.000Z'));

    await notifications.updatePreferences(tx, ME, { pausedUntil: null });
    expect(calls.email.pausedUntil).toBeNull();
  });

  it.each([
    ['in the past', '2026-09-27T11:59:59.000Z'],
    ['more than a year ahead', '2027-09-28T12:00:00.000Z'],
  ])('refuses a pause that ends %s', async (_name, pausedUntil) => {
    const { notifications, tx } = service();

    await expect(notifications.updatePreferences(tx, ME, { pausedUntil })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('adds a browser and removes it, and a browser that is not the reader’s is a 404', async () => {
    const { notifications, tx } = service();

    expect(
      await notifications.addSubscription(tx, ME, {
        endpoint: 'https://push.example.com/b',
        keys: { p256dh: 'abc', auth: 'def' },
        label: ' Firefox on Linux ',
      }),
    ).toEqual({
      id: SUBSCRIPTION,
      label: 'Firefox on Linux',
      createdAt: '2026-09-20T09:00:00.000Z',
    });

    await expect(notifications.removeSubscription(tx, ME, SUBSCRIPTION)).resolves.toBeUndefined();
    await expect(
      service({ deleted: false }).notifications.removeSubscription(tx, ME, SUBSCRIPTION),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
