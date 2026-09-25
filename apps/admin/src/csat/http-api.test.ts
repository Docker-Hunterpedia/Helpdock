import { describe, expect, it, vi } from 'vitest';
import { HttpCsatApi } from './http-api.js';

/**
 * The public adapter against a stubbed `fetch`: no session goes with it, and
 * every failure crosses as one of three problems the page can draw.
 */

const TOKEN = `${'A'.repeat(43)}.${'o'.repeat(43)}`;
const BRAND = { name: 'Helpdock', locale: 'en', accent: null };

const answering = (status: number, body: unknown = {}) =>
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

describe('HttpCsatApi', () => {
  it('reads the survey without sending any credentials', async () => {
    const fetcher = answering(200, { state: 'expired', brand: BRAND });

    await expect(new HttpCsatApi('/api/public/csat', fetcher).survey(TOKEN)).resolves.toEqual({
      state: 'expired',
      brand: BRAND,
    });
    expect(fetcher).toHaveBeenCalledWith(`/api/public/csat/${TOKEN}`, {
      method: 'GET',
      credentials: 'omit',
    });
  });

  it('posts the rating as JSON', async () => {
    const fetcher = answering(200, { state: 'rated', brand: BRAND, rating: 5 });

    await new HttpCsatApi('/api/public/csat', fetcher).rate(TOKEN, { rating: 5 });

    expect(fetcher).toHaveBeenCalledWith(
      `/api/public/csat/${TOKEN}`,
      expect.objectContaining({ method: 'POST', body: '{"rating":5}' }),
    );
  });

  it.each([
    [404, 'not-found'],
    [400, 'not-found'],
    [429, 'unavailable'],
    [500, 'unavailable'],
  ])('answers %i as %s', async (status, problem) => {
    await expect(
      new HttpCsatApi('/api/public/csat', answering(status)).survey(TOKEN),
    ).rejects.toMatchObject({ problem });
  });

  it('answers a network failure as unavailable', async () => {
    const fetcher = vi.fn(() => Promise.reject(new TypeError('offline')));

    await expect(new HttpCsatApi('/api/public/csat', fetcher).survey(TOKEN)).rejects.toMatchObject({
      problem: 'unavailable',
    });
  });
});
