import { describe, expect, it } from 'vitest';
import {
  excerptOf,
  NOTIFICATION_KINDS,
  NOTIFICATION_PREFERENCE_DEFAULTS,
  notificationListQuerySchema,
  notificationPreferencesSchema,
  notificationSchema,
  pushSubscriptionCreateSchema,
  resolveNotificationPreferences,
} from './notifications.js';

const KEYS = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};

describe('notification preferences', () => {
  it('has a default for every kind, and the defaults parse', () => {
    expect(Object.keys(NOTIFICATION_PREFERENCE_DEFAULTS)).toEqual([...NOTIFICATION_KINDS]);
    expect(notificationPreferencesSchema.parse(NOTIFICATION_PREFERENCE_DEFAULTS)).toEqual(
      NOTIFICATION_PREFERENCE_DEFAULTS,
    );
  });

  it('matches the artboard: warnings in-app only, breaches everywhere', () => {
    expect(NOTIFICATION_PREFERENCE_DEFAULTS.sla_warning).toEqual({
      inApp: true,
      email: false,
      push: false,
    });
    expect(NOTIFICATION_PREFERENCE_DEFAULTS.sla_breached).toEqual({
      inApp: true,
      email: true,
      push: true,
    });
  });

  it('reads nothing stored as the defaults', () => {
    expect(resolveNotificationPreferences(undefined)).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS);
    expect(resolveNotificationPreferences('garbage')).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS);
  });

  it('keeps what was stored and fills a kind that was not, or no longer parses', () => {
    const resolved = resolveNotificationPreferences({
      assigned: { inApp: false, email: false, push: false },
      replied: { inApp: 'yes' },
    });

    expect(resolved.assigned).toEqual({ inApp: false, email: false, push: false });
    expect(resolved.replied).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS.replied);
    expect(resolved.escalated).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS.escalated);
  });

  it('refuses a request that leaves a kind out or adds one', () => {
    const { escalated: _left, ...partial } = NOTIFICATION_PREFERENCE_DEFAULTS;

    expect(notificationPreferencesSchema.safeParse(partial).success).toBe(false);
    expect(
      notificationPreferencesSchema.safeParse({
        ...NOTIFICATION_PREFERENCE_DEFAULTS,
        telegram: { inApp: true, email: true, push: true },
      }).success,
    ).toBe(false);
  });
});

describe('pushSubscriptionCreateSchema', () => {
  it('takes what PushSubscription.toJSON() hands over', () => {
    expect(
      pushSubscriptionCreateSchema.parse({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: KEYS,
      }),
    ).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: KEYS, label: '' });
  });

  it.each([
    ['an http endpoint', { endpoint: 'http://push.example.com/abc', keys: KEYS }],
    [
      'a key that is not base64url',
      { endpoint: 'https://push.example.com/a', keys: { ...KEYS, auth: 'a b' } },
    ],
    ['a missing key', { endpoint: 'https://push.example.com/a', keys: { p256dh: KEYS.p256dh } }],
  ])('refuses %s', (_name, body) => {
    expect(pushSubscriptionCreateSchema.safeParse(body).success).toBe(false);
  });
});

describe('notificationListQuerySchema', () => {
  it('lists everything unless asked for the unread', () => {
    expect(notificationListQuerySchema.parse({})).toEqual({ filter: 'all' });
    expect(notificationListQuerySchema.parse({ filter: 'unread' })).toEqual({ filter: 'unread' });
    expect(notificationListQuerySchema.safeParse({ filter: 'read' }).success).toBe(false);
  });
});

describe('excerptOf', () => {
  it('flattens whitespace and keeps a short text whole', () => {
    expect(excerptOf('  @Lina can you\n\nconfirm?  ')).toBe('@Lina can you confirm?');
  });

  it('cuts a long text on a word boundary and marks the cut', () => {
    const text = `${'word '.repeat(40)}end`;
    const excerpt = excerptOf(text, 23);

    expect(excerpt).toBe('word word word word…');
  });

  it('cuts mid-word when there is no boundary worth keeping', () => {
    expect(excerptOf('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}…`);
  });
});

describe('a panel row (M14-04)', () => {
  const row = {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0001',
    kind: 'assigned',
    ticketId: '0192c3f0-1a2b-7c3d-8e4f-000000001042',
    ticketReference: 'HD-1042',
    subject: 'Refund',
    departmentName: 'Billing',
    departmentNameAr: null,
    actorName: 'Omar',
    excerpt: null,
    messageChannel: null,
    detail: { assignedBy: 'person' },
    createdAt: '2026-10-21T10:00:00.000Z',
    readAt: null,
  };

  it('carries the bulk edit that caused it, or null', () => {
    const operation = '0192c3f0-1a2b-7c3d-8e4f-0000000b0001';

    expect(
      notificationSchema.parse({ ...row, bulkOperationId: operation, bulkOperationCount: 12 }),
    ).toMatchObject({ bulkOperationId: operation, bulkOperationCount: 12 });
    expect(
      notificationSchema.parse({ ...row, bulkOperationId: null, bulkOperationCount: 0 }),
    ).toMatchObject({ bulkOperationId: null, bulkOperationCount: 0 });
  });

  it('refuses a row that does not say, and an operation that is not an id', () => {
    expect(notificationSchema.safeParse(row).success).toBe(false);
    expect(
      notificationSchema.safeParse({ ...row, bulkOperationId: 'op', bulkOperationCount: 1 })
        .success,
    ).toBe(false);
    expect(
      notificationSchema.safeParse({ ...row, bulkOperationId: null, bulkOperationCount: -1 })
        .success,
    ).toBe(false);
  });
});
