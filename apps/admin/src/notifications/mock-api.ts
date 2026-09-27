import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  type NotificationList,
  type NotificationPreferences,
  type NotificationPreferencesView,
  type NotificationView,
  type PushSubscriptionCreate,
  type PushSubscriptionView,
} from '@helpdock/schemas';
import { MOCK_EMAIL } from '../auth/mock-api.js';
import {
  MOCK_TICKET_REFUND,
  MOCK_TICKET_SIGN_IN,
  MOCK_TICKET_TRANSCRIPT,
  MOCK_TICKET_VAT,
} from '../tickets/mock-api.js';
import type { NotificationsApi } from './api.js';

/**
 * The fixture behind the bell in the unit tests and the mock Playwright
 * projects: the six rows of the `AdminNotifications` artboard, three unread,
 * over the tickets the ticket fixture already has, so a click lands on a real
 * ticket.
 *
 * `MOCK_PUSH_KEY_STORAGE` set to `off` makes the install have no VAPID keys,
 * which is how the "Not set up on this install" card is reached in a browser
 * test without a second build.
 */

export const MOCK_PUSH_KEY_STORAGE = 'helpdock.mock.vapid';
export const MOCK_VAPID_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

const minutesAgo = (now: number, minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const fixture = (now: number): NotificationView[] => [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0001',
    kind: 'sla_breached',
    ticketId: MOCK_TICKET_REFUND,
    ticketReference: 'HD-1042',
    subject: 'Refund for order 42 has not arrived',
    departmentName: 'Billing',
    departmentNameAr: 'الفوترة',
    actorName: null,
    excerpt: null,
    messageChannel: null,
    detail: { clock: 'first_response' },
    createdAt: minutesAgo(now, 2),
    readAt: null,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0002',
    kind: 'mentioned',
    ticketId: MOCK_TICKET_SIGN_IN,
    ticketReference: 'HD-1041',
    subject: 'Cannot sign in to the portal',
    departmentName: 'Technical',
    departmentNameAr: 'الدعم التقني',
    actorName: 'Omar Nasser',
    excerpt: '@Lina can you confirm from finance?',
    messageChannel: 'manual',
    detail: {},
    createdAt: minutesAgo(now, 14),
    readAt: null,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0003',
    kind: 'assigned',
    ticketId: MOCK_TICKET_TRANSCRIPT,
    ticketReference: 'HD-1028',
    subject: 'Chat transcript request',
    departmentName: 'Billing',
    departmentNameAr: 'الفوترة',
    actorName: null,
    excerpt: null,
    messageChannel: null,
    detail: { assignedBy: 'round_robin' },
    createdAt: minutesAgo(now, 32),
    readAt: null,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0004',
    kind: 'sla_warning',
    ticketId: MOCK_TICKET_REFUND,
    ticketReference: 'HD-1042',
    subject: 'Refund for order 42 has not arrived',
    departmentName: 'Billing',
    departmentNameAr: 'الفوترة',
    actorName: null,
    excerpt: null,
    messageChannel: null,
    detail: { clock: 'resolution', stepPercent: 80 },
    createdAt: minutesAgo(now, 60),
    readAt: minutesAgo(now, 50),
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0005',
    kind: 'replied',
    ticketId: MOCK_TICKET_VAT,
    ticketReference: 'HD-1035',
    subject: 'Invoice 2291 shows the wrong VAT',
    departmentName: 'Billing',
    departmentNameAr: 'الفوترة',
    actorName: null,
    excerpt: 'Attached the corrected PDF.',
    messageChannel: 'email',
    detail: {},
    createdAt: minutesAgo(now, 120),
    readAt: minutesAgo(now, 100),
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0006',
    kind: 'escalated',
    ticketId: MOCK_TICKET_VAT,
    ticketReference: 'HD-1035',
    subject: 'Invoice 2291 shows the wrong VAT',
    departmentName: 'Billing',
    departmentNameAr: 'الفوترة',
    actorName: null,
    excerpt: null,
    messageChannel: null,
    detail: { stepPercent: 120, clock: 'resolution' },
    createdAt: minutesAgo(now, 26 * 60),
    readAt: minutesAgo(now, 25 * 60),
  },
];

const readStorage = (key: string): string | null => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

export class MockNotificationsApi implements NotificationsApi {
  readonly #items: NotificationView[];
  #preferences: NotificationPreferences = NOTIFICATION_PREFERENCE_DEFAULTS;
  readonly #subscriptions: (PushSubscriptionView & { endpoint: string })[] = [];
  readonly #pushConfigured: boolean;
  /** Test pushes "sent", for a unit test to read. */
  readonly testPushes: string[] = [];
  #nextId = 1;

  constructor({
    now = Date.now(),
    pushConfigured = readStorage(MOCK_PUSH_KEY_STORAGE) !== 'off',
    items,
  }: { now?: number; pushConfigured?: boolean; items?: NotificationView[] } = {}) {
    this.#items = items ?? fixture(now);
    this.#pushConfigured = pushConfigured;
  }

  async list(_brandId: string, filter: 'all' | 'unread'): Promise<NotificationList> {
    const unread = this.#items.filter((item) => item.readAt === null);

    return {
      items: (filter === 'unread' ? unread : this.#items).map((item) => ({ ...item })),
      unreadCount: unread.length,
    };
  }

  async markRead(_brandId: string, notificationId: string): Promise<void> {
    const item = this.#items.find((candidate) => candidate.id === notificationId);
    if (item !== undefined && item.readAt === null) {
      item.readAt = new Date().toISOString();
    }
  }

  async markAllRead(_brandId: string): Promise<void> {
    const at = new Date().toISOString();
    for (const item of this.#items) {
      item.readAt ??= at;
    }
  }

  async testPush(_brandId: string, subscriptionId: string): Promise<void> {
    this.testPushes.push(subscriptionId);
  }

  async preferences(): Promise<NotificationPreferencesView> {
    return {
      preferences: this.#preferences,
      email: MOCK_EMAIL,
      locale: 'en',
      push: {
        configured: this.#pushConfigured,
        publicKey: this.#pushConfigured ? MOCK_VAPID_PUBLIC_KEY : null,
        subscriptions: this.#subscriptions.map(({ endpoint: _endpoint, ...view }) => view),
      },
    };
  }

  async updatePreferences(
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferencesView> {
    this.#preferences = preferences;

    return this.preferences();
  }

  async subscribe(subscription: PushSubscriptionCreate): Promise<PushSubscriptionView> {
    const existing = this.#subscriptions.find((row) => row.endpoint === subscription.endpoint);
    if (existing !== undefined) {
      return { id: existing.id, label: existing.label, createdAt: existing.createdAt };
    }

    const row = {
      id: `0192c3f0-1a2b-7c3d-8e4f-0000000b${String(this.#nextId++).padStart(4, '0')}`,
      endpoint: subscription.endpoint,
      label: subscription.label?.trim() ?? '',
      createdAt: new Date().toISOString(),
    };
    this.#subscriptions.push(row);

    return { id: row.id, label: row.label, createdAt: row.createdAt };
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const index = this.#subscriptions.findIndex((row) => row.id === subscriptionId);
    if (index >= 0) {
      this.#subscriptions.splice(index, 1);
    }
  }
}
