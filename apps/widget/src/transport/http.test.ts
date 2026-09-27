import { describe, expect, it, vi } from 'vitest';
import { ApiRefusal, HttpClient, refusalOf } from './http.js';

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

  it("turns the api's refusal into the code the UI words, keeping the api's reason", async () => {
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
      code: 'captcha_failed',
      reason: 'captcha_required',
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

  it('reports a body the connection cut off as a network failure', async () => {
    const http = new HttpClient({
      apiUrl: 'https://api.example.com',
      brandId: BRAND,
      secret: () => 's',
      fetch: async () => new Response('{"cut', { status: 200 }),
    });

    await expect(http.get('/config')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('HttpClient.put', () => {
  const blob = new Blob(['x'], { type: 'image/png' });

  it('uploads with exactly the headers the URL was signed with', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const http = new HttpClient({ apiUrl: 'https://a', brandId: BRAND, secret: () => 's', fetch });

    await http.put('https://bucket/object', { 'content-type': 'image/png' }, blob);

    expect(fetch).toHaveBeenCalledWith('https://bucket/object', {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: blob,
    });
  });

  it('reports a refused or unreachable upload as a network failure', async () => {
    const refused = new HttpClient({
      apiUrl: 'https://a',
      brandId: BRAND,
      secret: () => 's',
      fetch: async () => new Response(null, { status: 403 }),
    });
    const offline = new HttpClient({
      apiUrl: 'https://a',
      brandId: BRAND,
      secret: () => 's',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    await expect(refused.put('https://bucket/object', {}, blob)).rejects.toBeInstanceOf(ApiRefusal);
    await expect(offline.put('https://bucket/object', {}, blob)).rejects.toMatchObject({
      code: 'network',
    });
  });
});

describe('refusalOf', () => {
  it('falls back to the status when the body names no widget code', () => {
    expect(refusalOf(429, {})).toMatchObject({ code: 'rate_limited', reason: 'rate_limited' });
    expect(refusalOf(503, undefined)).toMatchObject({ code: 'unavailable', reason: 'internal' });
    expect(refusalOf(418, { error: { widget: { reason: 'nonsense' } } })).toMatchObject({
      code: 'policy_rejected',
      reason: 'invalid_payload',
    });
  });

  it('words what a retry cannot fix as final, and an origin problem as unavailable', () => {
    const codeOf = (reason: string) => refusalOf(400, { error: { widget: { reason } } }).code;

    expect(codeOf('content_policy')).toBe('policy_rejected');
    expect(codeOf('read_only')).toBe('policy_rejected');
    expect(codeOf('not_found')).toBe('not_found');
    expect(codeOf('origin_not_allowed')).toBe('unavailable');
    expect(codeOf('unauthenticated')).toBe('unavailable');
  });
});
