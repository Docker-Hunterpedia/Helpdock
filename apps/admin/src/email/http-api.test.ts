import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpEmailApi } from './http-api.js';
import { MockEmailApi } from './mock-api.js';

/**
 * The adapter against a stubbed `fetch`: which route each call reaches, with
 * what body, and that the answer is parsed through its schema. That the routes
 * behave is the api's integration suite.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000001042';
const MESSAGE = '0192c3f0-1a2b-7c3d-8e4f-000000000704';
const DELIVERY = '0192c3f0-1a2b-7c3d-8e4f-000000000f01';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (): Response => new Response(null, { status: 204 });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpEmailApi;
const fixture = new MockEmailApi();

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpEmailApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = (): { method: string; url: string; body: unknown }[] =>
  fetchMock.mock.calls.map(([url, init]) => ({
    method: String((init as RequestInit).method),
    url: String(url),
    body:
      (init as RequestInit).body === undefined
        ? undefined
        : JSON.parse(String((init as RequestInit).body)),
  }));

describe('HttpEmailApi', () => {
  it('reads and saves each section of Outgoing email', async () => {
    const settings = await fixture.outgoing(BRAND);
    fetchMock.mockImplementation(async () => json(settings));
    const smtp = { host: 'smtp.example.com', port: 587, tls: 'starttls' as const, user: '' };

    await api.outgoing(BRAND);
    await api.saveSmtp(BRAND, smtp);
    await api.saveSenders(BRAND, settings.senders);
    await api.saveAutoReplies(BRAND, settings.autoReplies);

    expect(calls().map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /api/brands/${BRAND}/email/outgoing`,
      `PUT /api/brands/${BRAND}/email/outgoing/smtp`,
      `PUT /api/brands/${BRAND}/email/outgoing/senders`,
      `PUT /api/brands/${BRAND}/email/outgoing/auto-replies`,
    ]);
    expect(calls()[1]?.body).toEqual(smtp);
  });

  it('tests the server on screen and parses the outcome', async () => {
    fetchMock.mockResolvedValue(
      json({ delivered: false, recipient: 'lina@helpdock.io', durationMs: 5, error: 'timeout' }),
    );

    const result = await api.testSmtp(BRAND, { host: 'h', port: 25, tls: 'none', user: '' });

    expect(result.error).toBe('timeout');
    expect(calls()[0]?.url).toBe(`/api/brands/${BRAND}/email/outgoing/smtp/test`);
  });

  it('lists, retries and discards failed sends', async () => {
    fetchMock
      .mockResolvedValueOnce(json(await fixture.failedSends(BRAND)))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ retried: 2 }));

    expect((await api.failedSends(BRAND)).items).toHaveLength(2);
    await api.retryFailedSend(BRAND, DELIVERY);
    await api.discardFailedSend(BRAND, DELIVERY);
    expect(await api.retryAllFailedSends(BRAND)).toBe(2);

    expect(calls().map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /api/brands/${BRAND}/email/failed-sends`,
      `POST /api/brands/${BRAND}/email/failed-sends/${DELIVERY}/retry`,
      `POST /api/brands/${BRAND}/email/failed-sends/${DELIVERY}/discard`,
      `POST /api/brands/${BRAND}/email/failed-sends/retry-all`,
    ]);
  });

  it("reads and saves the person's own signature", async () => {
    fetchMock.mockImplementation(async () => json({ en: 'Lina', ar: '' }));

    await api.signature();
    await api.saveSignature({ en: 'Lina', ar: '' });

    expect(calls().map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /api/me/signature',
      'PUT /api/me/signature',
    ]);
  });

  it("reads a ticket's email context and retries one reply", async () => {
    fetchMock
      .mockResolvedValueOnce(json(await fixture.ticketEmail(BRAND, TICKET)))
      .mockResolvedValueOnce(empty());

    const context = await api.ticketEmail(BRAND, TICKET);
    await api.retryMessage(BRAND, TICKET, MESSAGE);

    expect(context.to?.address).toBe('mona@example.com');
    expect(calls()[1]?.url).toBe(
      `/api/brands/${BRAND}/tickets/${TICKET}/email/messages/${MESSAGE}/retry`,
    );
  });
});
