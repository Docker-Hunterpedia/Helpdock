import type { DbTransaction } from '@helpdock/db';
import { NOTIFICATION_PREFERENCE_DEFAULTS, type NotificationPreferences } from '@helpdock/schemas';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
  saved?: NotificationPreferences;
}

const service = ({
  vapid = 'public-key',
  marked = true,
  deleted = true,
  subscriptionOwner = ME,
}: {
  vapid?: string | null;
  marked?: boolean;
  deleted?: boolean;
  subscriptionOwner?: string;
} = {}) => {
  const calls: Calls = { outbox: [] };
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
    savePreferences: async (_tx: DbTransaction, _user: string, saved: NotificationPreferences) => {
      calls.saved = saved;
    },
    account: async () => ({ email: 'lina@helpdock.test', locale: 'en' as const }),
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
      { vapidPublicKey: async () => vapid },
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
    });
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

    expect((await notifications.updatePreferences(tx, ME, changed)).preferences).toEqual(changed);
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
