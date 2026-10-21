import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpSettingsApi } from './http-api.js';
import { MOCK_AUTHENTICATION_SETTINGS, MOCK_INSTALL_PASSKEYS } from './mock-api.js';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpSettingsApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpSettingsApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpSettingsApi', () => {
  it('reads and saves the install authentication settings through their declared route', async () => {
    fetchMock.mockResolvedValueOnce(json(MOCK_AUTHENTICATION_SETTINGS));

    await expect(api.authentication()).resolves.toEqual(MOCK_AUTHENTICATION_SETTINGS);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/install/settings/authentication',
      expect.objectContaining({ method: 'GET' }),
    );

    const request = {
      requireTwoFactor: false,
      magicLinkValidityMinutes: 20,
      google: { clientId: MOCK_AUTHENTICATION_SETTINGS.google.clientId },
      microsoft: { clientId: 'ms-id', tenantId: '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f' },
      github: { clientId: 'github-id', clientSecret: 'github-secret' },
    };
    fetchMock.mockResolvedValueOnce(
      json({
        ...MOCK_AUTHENTICATION_SETTINGS,
        requireTwoFactor: false,
        magicLinkValidityMinutes: 20,
      }),
    );

    await api.saveAuthentication(request);

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe('/api/install/settings/authentication');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it('refuses a response that exposes a secret', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        ...MOCK_AUTHENTICATION_SETTINGS,
        google: { ...MOCK_AUTHENTICATION_SETTINGS.google, clientSecret: 'must-not-leak' },
      }),
    );

    await expect(api.authentication()).rejects.toThrow();
  });

  it('reads the passkey status and moves the passkeys through their declared routes', async () => {
    const status = {
      state: 'paused',
      rpId: 'desk.helpdock.com',
      pinnedRpId: 'admin.helpdock.com',
      pinnedAt: '2026-10-20T08:00:00.000Z',
      pinLocked: false,
      passkeyCount: 3,
      holderCount: 2,
    };
    fetchMock.mockResolvedValueOnce(json(status));

    await expect(api.passkeys()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/install/passkeys',
      expect.objectContaining({ method: 'GET' }),
    );

    const moved = { rpId: 'desk.helpdock.com', passkeysRemoved: 3, holdersNotified: 2 };
    fetchMock.mockResolvedValueOnce(json(moved));

    await expect(api.movePasskeys()).resolves.toEqual(moved);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/install/passkeys/move',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('refuses a passkey status that carries anything beyond counts', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ ...MOCK_INSTALL_PASSKEYS, holders: ['lina@example.com'] }),
    );

    await expect(api.passkeys()).rejects.toThrow();
  });
});
