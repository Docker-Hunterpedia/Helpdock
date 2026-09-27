import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationServerKey,
  deviceOf,
  MOCK_PUSH_PERMISSION_STORAGE,
  MockBrowserPush,
  PushDeniedError,
} from './browser-push.js';

describe('applicationServerKey', () => {
  it('turns a base64url key into its bytes, padding it first', () => {
    expect([...applicationServerKey('AQID')]).toEqual([1, 2, 3]);
    expect([...applicationServerKey('-_8')]).toEqual([251, 255]);
  });
});

describe('deviceOf', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
      { browser: 'Chrome', os: 'macOS' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0',
      { browser: 'Edge', os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      { browser: 'Firefox', os: 'Linux' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android' },
    ],
    ['curl/8.0', { browser: 'Browser', os: 'this device' }],
  ])('reads %s', (userAgent, expected) => {
    expect(deviceOf(userAgent)).toEqual(expected);
  });
});

describe('MockBrowserPush', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('asks once, subscribes, and unsubscribes', async () => {
    const push = new MockBrowserPush();
    expect(push.permission()).toBe('default');

    const subscription = await push.subscribe('key');

    expect(push.permission()).toBe('granted');
    expect(await push.subscribed()).toBe(true);
    expect(subscription.endpoint).toMatch(/^https:\/\//);

    await push.unsubscribe();
    expect(await push.subscribed()).toBe(false);
  });

  it('answers the prompt with "block" when a browser test asks it to', async () => {
    window.localStorage.setItem(MOCK_PUSH_PERMISSION_STORAGE, 'denied');
    const push = new MockBrowserPush();

    await expect(push.subscribe('key')).rejects.toBeInstanceOf(PushDeniedError);
    expect(push.permission()).toBe('denied');
  });

  it('names a device', () => {
    expect(new MockBrowserPush().device()).toEqual({ browser: 'Chrome', os: 'macOS' });
  });
});
