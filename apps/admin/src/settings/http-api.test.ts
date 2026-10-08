import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpSettingsApi } from './http-api.js';
import { MOCK_AUTHENTICATION_SETTINGS } from './mock-api.js';

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
});
