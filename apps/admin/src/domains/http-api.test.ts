import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isDomainsError } from './api.js';
import { HttpDomainsApi } from './http-api.js';

/**
 * The Domains adapter against a stubbed `fetch`: the paths and bodies it
 * sends, what it parses, and what a refusal becomes. That the routes behave is
 * `domains.integration.test.ts` in the api.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const DOMAIN = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

const domain = {
  id: DOMAIN,
  domain: 'support.acme.com',
  primary: false,
  cloudflareProxied: false,
  state: 'pending',
  tls: null,
  records: {
    cname: { type: 'CNAME', name: 'support.acme.com', value: 'edge.helpdock.io', seen: false },
    txt: {
      type: 'TXT',
      name: '_helpdock.support.acme.com',
      value: 'helpdock-verify=abc',
      seen: false,
    },
  },
  failure: null,
  verifiedAt: null,
  tlsIssuedAt: null,
  lastCheckedAt: null,
  createdAt: '2026-09-27T09:00:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpDomainsApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpDomainsApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = (): { url: string; method: string; body: unknown } => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
};

describe('HttpDomainsApi', () => {
  it('lists, adds, checks, updates and removes domains', async () => {
    fetchMock.mockResolvedValueOnce(json({ cnameTarget: 'edge.helpdock.io', domains: [domain] }));
    expect((await api.domains(BRAND)).domains).toHaveLength(1);
    expect(lastCall()).toMatchObject({ url: `/api/brands/${BRAND}/domains`, method: 'GET' });

    fetchMock.mockResolvedValueOnce(json(domain, 201));
    await api.addDomain(BRAND, 'support.acme.com');
    expect(lastCall()).toMatchObject({ method: 'POST', body: { domain: 'support.acme.com' } });

    fetchMock.mockResolvedValueOnce(json(domain, 202));
    await api.checkDomain(BRAND, DOMAIN);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      url: `/api/brands/${BRAND}/domains/${DOMAIN}/check`,
    });

    fetchMock.mockResolvedValueOnce(json({ ...domain, cloudflareProxied: true }));
    expect(
      (await api.updateDomain(BRAND, DOMAIN, { cloudflareProxied: true })).cloudflareProxied,
    ).toBe(true);
    expect(lastCall()).toMatchObject({ method: 'PATCH', body: { cloudflareProxied: true } });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.removeDomain(BRAND, DOMAIN);
    expect(lastCall()).toMatchObject({
      method: 'DELETE',
      url: `/api/brands/${BRAND}/domains/${DOMAIN}`,
    });
  });

  it('turns a domain refusal into a DomainsError carrying its reason', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: 'taken',
            requestId: 'r1',
            domains: { reason: 'domain-taken' },
          },
        },
        409,
      ),
    );

    const error = await api.addDomain(BRAND, 'support.acme.com').catch((caught: unknown) => caught);

    expect(isDomainsError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'domain-taken' });
  });
});
