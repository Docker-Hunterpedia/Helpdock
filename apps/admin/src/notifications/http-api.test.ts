import { NOTIFICATION_PREFERENCE_DEFAULTS } from '@helpdock/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpNotificationsApi } from './http-api.js';

/** The adapter against a stubbed `fetch`: the paths it asks and what it parses. */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const NOTIFICATION = '0192c3f0-1a2b-7c3d-8e4f-0000000a0001';
const SUBSCRIPTION = '0192c3f0-1a2b-7c3d-8e4f-0000000b0001';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });

const view = {
  preferences: NOTIFICATION_PREFERENCE_DEFAULTS,
  email: 'lina@helpdock.com',
  locale: 'en',
  push: { configured: false, publicKey: null, subscriptions: [] },
};

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpNotificationsApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpNotificationsApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = (): [string, string | undefined, unknown][] =>
  fetchMock.mock.calls.map(([url, init]) => [
    String(url),
    (init as RequestInit).method,
    (init as RequestInit).body === undefined
      ? undefined
      : JSON.parse(String((init as RequestInit).body)),
  ]);

describe('HttpNotificationsApi', () => {
  it('reads the panel of one brand, filtered', async () => {
    fetchMock.mockResolvedValue(json({ items: [], unreadCount: 0 }));

    expect(await api.list(BRAND, 'unread')).toEqual({ items: [], unreadCount: 0 });
    expect(calls()).toEqual([
      [`/api/brands/${BRAND}/notifications?filter=unread`, 'GET', undefined],
    ]);
  });

  it('marks one and all read, and asks for a test push', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(noContent()));

    await api.markRead(BRAND, NOTIFICATION);
    await api.markAllRead(BRAND);
    await api.testPush(BRAND, SUBSCRIPTION);

    expect(calls()).toEqual([
      [`/api/brands/${BRAND}/notifications/${NOTIFICATION}/read`, 'POST', undefined],
      [`/api/brands/${BRAND}/notifications/read-all`, 'POST', undefined],
      [`/api/brands/${BRAND}/notifications/test-push`, 'POST', { subscriptionId: SUBSCRIPTION }],
    ]);
  });

  it('reads and saves the preferences', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(view)));

    expect(await api.preferences()).toEqual(view);
    await api.updatePreferences(NOTIFICATION_PREFERENCE_DEFAULTS);

    expect(calls()).toEqual([
      ['/api/me/notification-preferences', 'GET', undefined],
      [
        '/api/me/notification-preferences',
        'PUT',
        { preferences: NOTIFICATION_PREFERENCE_DEFAULTS },
      ],
    ]);
  });

  it('adds and removes a browser', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ id: SUBSCRIPTION, label: 'Chrome · macOS', createdAt: '2026-09-20T09:00:00.000Z' }),
      )
      .mockResolvedValueOnce(noContent());
    const subscription = {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'k', auth: 'a' },
      label: 'Chrome · macOS',
    };

    expect((await api.subscribe(subscription)).id).toBe(SUBSCRIPTION);
    await api.unsubscribe(SUBSCRIPTION);

    expect(calls()).toEqual([
      ['/api/me/push-subscriptions', 'POST', subscription],
      [`/api/me/push-subscriptions/${SUBSCRIPTION}`, 'DELETE', undefined],
    ]);
  });
});
