import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_PUSH_KEY_STORAGE, MockNotificationsApi } from './mock-api.js';

const BRAND = 'brand';
const subscription = {
  endpoint: 'https://push.example.com/a',
  keys: { p256dh: 'k', auth: 'a' },
  label: ' Chrome · macOS ',
};

describe('MockNotificationsApi', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('starts with the artboard rows, three of them unread', async () => {
    const api = new MockNotificationsApi();

    expect((await api.list(BRAND, 'all')).items).toHaveLength(6);
    expect((await api.list(BRAND, 'unread')).unreadCount).toBe(3);
  });

  it('marks one read once, and then the rest', async () => {
    const api = new MockNotificationsApi();
    const [first] = (await api.list(BRAND, 'unread')).items;

    await api.markRead(BRAND, first?.id ?? '');
    const readAt = (await api.list(BRAND, 'all')).items[0]?.readAt;
    await api.markRead(BRAND, first?.id ?? '');

    expect((await api.list(BRAND, 'all')).items[0]?.readAt).toBe(readAt);
    await api.markAllRead(BRAND);
    expect((await api.list(BRAND, 'unread')).items).toEqual([]);
  });

  it('keeps one row per browser endpoint, trimmed, and forgets it on unsubscribe', async () => {
    const api = new MockNotificationsApi({ pushConfigured: true });

    const first = await api.subscribe(subscription);
    const again = await api.subscribe(subscription);

    expect(again.id).toBe(first.id);
    expect(first.label).toBe('Chrome · macOS');
    expect((await api.preferences()).push.subscriptions).toHaveLength(1);

    await api.unsubscribe(first.id);
    await api.unsubscribe(first.id);
    expect((await api.preferences()).push.subscriptions).toEqual([]);
  });

  it('has no VAPID keys when a browser test switches them off', async () => {
    window.localStorage.setItem(MOCK_PUSH_KEY_STORAGE, 'off');

    expect((await new MockNotificationsApi().preferences()).push).toMatchObject({
      configured: false,
      publicKey: null,
    });
  });
});
