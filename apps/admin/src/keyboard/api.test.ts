import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpKeyboardApi, MOCK_SINGLE_KEY_STORAGE, MockKeyboardApi } from './api.js';

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
  it('reads and saves the caller’s own switch at /api/me/keyboard', async () => {
    const api = new HttpKeyboardApi(new HttpTransport());
    fetchMock
      .mockResolvedValueOnce(json({ singleKeyShortcuts: true }))
      .mockResolvedValueOnce(json({ singleKeyShortcuts: false }));

    expect(await api.preferences()).toEqual({ singleKeyShortcuts: true });
    expect(await api.save({ singleKeyShortcuts: false })).toEqual({ singleKeyShortcuts: false });

    const calls = (fetchMock.mock.calls as [string, RequestInit][]).map(([url, init]) => [
      String(url),
      init.method,
      init.body === undefined ? undefined : JSON.parse(String(init.body)),
    ]);
    expect(calls).toEqual([
      ['/api/me/keyboard', 'GET', undefined],
      ['/api/me/keyboard', 'PUT', { singleKeyShortcuts: false }],
    ]);
  });

  it('refuses an answer that is not the switch', async () => {
    fetchMock.mockResolvedValue(json({ singleKeyShortcuts: 'yes' }));

    await expect(new HttpKeyboardApi(new HttpTransport()).preferences()).rejects.toThrow();
  });
});

describe('MockKeyboardApi', () => {
  it('starts on, keeps what is saved, and can start off for a browser test', async () => {
    const api = new MockKeyboardApi();
    expect(await api.preferences()).toEqual({ singleKeyShortcuts: true });
    await api.save({ singleKeyShortcuts: false });
    expect(await api.preferences()).toEqual({ singleKeyShortcuts: false });

    localStorage.setItem(MOCK_SINGLE_KEY_STORAGE, 'off');
    expect(await new MockKeyboardApi().preferences()).toEqual({ singleKeyShortcuts: false });
  });
});
