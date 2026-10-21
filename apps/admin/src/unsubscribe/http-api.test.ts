import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsubscribeLinkError } from './api.js';
import { HttpUnsubscribeApi } from './http-api.js';

/** The adapter against a stubbed `fetch`: no credentials, RFC 8058's body, and the failures it names. */

const TOKEN = `${'A'.repeat(27)}.${'b'.repeat(43)}`;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const apiWith = (fetcher: ReturnType<typeof vi.fn>) =>
  new HttpUnsubscribeApi('/api/public/unsubscribe', fetcher as unknown as typeof fetch);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpUnsubscribeApi', () => {
  it('reads the confirmation with a GET and no credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ state: 'confirm', email: 'a@b.c', locale: 'en' }));

    expect(await apiWith(fetcher).view(TOKEN)).toEqual({
      state: 'confirm',
      email: 'a@b.c',
      locale: 'en',
    });
    expect(fetcher).toHaveBeenCalledWith(`/api/public/unsubscribe/${TOKEN}`, {
      method: 'GET',
      credentials: 'omit',
    });
  });

  it('unsubscribes with the one-click POST of RFC 8058, as a form, with no credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ state: 'done', locale: 'ar' }));

    expect(await apiWith(fetcher).unsubscribe(TOKEN)).toEqual({ state: 'done', locale: 'ar' });
    expect(fetcher).toHaveBeenCalledWith(`/api/public/unsubscribe/${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      credentials: 'omit',
    });
  });

  it.each([
    [404, 'not-found'],
    [400, 'not-found'],
    [429, 'unavailable'],
    [500, 'unavailable'],
  ])('maps a %i to %s', async (status, problem) => {
    const fetcher = vi.fn().mockResolvedValue(json({}, status));

    await expect(apiWith(fetcher).view(TOKEN)).rejects.toMatchObject({
      name: 'UnsubscribeLinkError',
      problem,
    });
  });

  it('maps a network failure to unavailable', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'));

    await expect(apiWith(fetcher).unsubscribe(TOKEN)).rejects.toBeInstanceOf(UnsubscribeLinkError);
  });
});
