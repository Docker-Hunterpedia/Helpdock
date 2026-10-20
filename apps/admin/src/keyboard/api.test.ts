import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { MOCK_SINGLE_KEY_STORAGE } from '../auth/mock-api.js';
import { signedInMockAuth } from '../test/signed-in.js';
import { HttpKeyboardApi, MockKeyboardApi } from './api.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(MOCK_SINGLE_KEY_STORAGE);
});

describe('HttpKeyboardApi', () => {
  it('saves the caller’s own switch at /api/me/keyboard', async () => {
    fetchMock.mockResolvedValue(json({ singleKeyShortcuts: false }));

    const saved = await new HttpKeyboardApi(new HttpTransport()).save({
      singleKeyShortcuts: false,
    });

    expect(saved).toEqual({ singleKeyShortcuts: false });
    const [url, init] = (fetchMock.mock.calls as [string, RequestInit][])[0] ?? [];
    expect([String(url), init?.method, JSON.parse(String(init?.body))]).toEqual([
      '/api/me/keyboard',
      'PUT',
      { singleKeyShortcuts: false },
    ]);
  });

  it('refuses an answer that is not the switch', async () => {
    fetchMock.mockResolvedValue(json({ singleKeyShortcuts: 'yes' }));

    await expect(
      new HttpKeyboardApi(new HttpTransport()).save({ singleKeyShortcuts: true }),
    ).rejects.toThrow();
  });
});

describe('the fixtures', () => {
  it('carry a saved switch in the next session, as the api does', async () => {
    const auth = await signedInMockAuth();
    expect((await auth.me())?.user.singleKeyShortcuts).toBeUndefined();

    await new MockKeyboardApi(auth).save({ singleKeyShortcuts: false });

    expect((await auth.me())?.user.singleKeyShortcuts).toBe(false);
  });

  it('start an account with the switch off when a browser test seeds it', async () => {
    localStorage.setItem(MOCK_SINGLE_KEY_STORAGE, 'off');

    const auth = await signedInMockAuth();

    expect((await auth.me())?.user.singleKeyShortcuts).toBe(false);
  });
});
