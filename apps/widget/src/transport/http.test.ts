import { describe, expect, it, vi } from 'vitest';
import { WidgetTransportError } from './contract.js';
import { HttpClient, isRetryable, refusalOf } from './http.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

describe('HttpClient', () => {
  it('sends the visitor credential and JSON, and reads JSON back', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const http = new HttpClient({
      apiUrl: 'https://api.example.com/',
      brandId: BRAND,
      secret: () => 'the-secret',
      fetch,
    });

    await expect(http.post('/session', { locale: 'ar' })).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledWith(`https://api.example.com/api/widget/${BRAND}/session`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Visitor the-secret',
      },
      body: '{"locale":"ar"}',
    });
  });

  it('sends no credential before one is issued, and answers nothing for a 202', async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 202 }),
    );
    const http = new HttpClient({
      apiUrl: 'https://api.example.com',
      brandId: BRAND,
      secret: () => null,
      fetch,
    });

    await expect(http.get('/config')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ accept: 'application/json' });
  });

  it("turns the api's refusal into its widget code", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'no', widget: { reason: 'captcha_required' } } }),
          { status: 403 },
        ),
    );
    const http = new HttpClient({
      apiUrl: 'https://api.example.com',
      brandId: BRAND,
      secret: () => 's',
      fetch,
    });

    await expect(http.post('/conversations', {})).rejects.toMatchObject({
      code: 'captcha_required',
      status: 403,
      message: 'no',
    });
  });

  it('reports a fetch that could not reach the api as a network failure', async () => {
    const http = new HttpClient({
      apiUrl: 'https://api.example.com',
      brandId: BRAND,
      secret: () => 's',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    await expect(http.get('/config')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('refusalOf', () => {
  it('falls back to the status when the body names no widget code', () => {
    expect(refusalOf(429, {}).code).toBe('rate_limited');
    expect(refusalOf(503, undefined).code).toBe('internal');
    expect(refusalOf(418, { error: { widget: { reason: 'nonsense' } } }).code).toBe(
      'invalid_payload',
    );
  });
});

describe('isRetryable', () => {
  it('retries the network and a server error, never a refusal', () => {
    expect(isRetryable(new WidgetTransportError('network', 'x'))).toBe(true);
    expect(isRetryable(new WidgetTransportError('internal', 'x', 502))).toBe(true);
    expect(isRetryable(new WidgetTransportError('not_found', 'x', 404))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });
});
