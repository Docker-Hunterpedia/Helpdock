import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isChannelsError } from './api.js';
import { HttpChannelsApi } from './http-api.js';

/**
 * The Channels adapter against a stubbed `fetch`: the paths and bodies it
 * sends, what it parses, and what a refusal becomes. That the routes behave is
 * `channels.integration.test.ts` in the api.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const MAILBOX = '0192c3f0-1a2b-7c3d-8e4f-0000000000e1';
const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000001042';
const MESSAGE = '0192c3f0-1a2b-7c3d-8e4f-0000000000f1';

const mailbox = {
  id: MAILBOX,
  address: 'support@helpdock.io',
  displayName: 'Support',
  departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
  departmentName: 'Support',
  method: 'inbound_parse',
  imap: null,
  inboundProvider: null,
  remoteImages: 'block',
  authFailureIsSpam: false,
  automatedAllowlist: [],
  health: {
    state: 'waiting',
    lastPolledAt: null,
    lastSuccessAt: null,
    lastReceivedAt: null,
    lastError: null,
    lastErrorKind: null,
    lastErrorAt: null,
  },
  createdAt: '2026-09-01T09:00:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpChannelsApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpChannelsApi(new HttpTransport());
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

describe('HttpChannelsApi', () => {
  it('lists, reads, creates, updates and deletes mailboxes', async () => {
    fetchMock.mockResolvedValueOnce(json({ mailboxes: [mailbox] }));
    expect((await api.mailboxes(BRAND)).mailboxes).toHaveLength(1);
    expect(lastCall()).toMatchObject({ url: `/api/brands/${BRAND}/mailboxes`, method: 'GET' });

    fetchMock.mockResolvedValueOnce(json(mailbox));
    await api.mailbox(BRAND, MAILBOX);
    expect(lastCall().url).toBe(`/api/brands/${BRAND}/mailboxes/${MAILBOX}`);

    const request = {
      address: 'support@helpdock.io',
      displayName: 'Support',
      departmentId: mailbox.departmentId,
      method: 'inbound_parse' as const,
      remoteImages: 'block' as const,
      authFailureIsSpam: false,
      automatedAllowlist: [],
    };
    fetchMock.mockResolvedValueOnce(json(mailbox, 201));
    await api.createMailbox(BRAND, request);
    expect(lastCall()).toMatchObject({ method: 'POST', body: request });

    fetchMock.mockResolvedValueOnce(json(mailbox));
    await api.updateMailbox(BRAND, MAILBOX, request);
    expect(lastCall()).toMatchObject({
      method: 'PUT',
      url: `/api/brands/${BRAND}/mailboxes/${MAILBOX}`,
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteMailbox(BRAND, MAILBOX);
    expect(lastCall().method).toBe('DELETE');
  });

  it('posts Test IMAP and parses either answer', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ ok: false, kind: 'auth', host: 'imap.example.com', port: 993, serverResponse: 'NO' }),
    );
    const result = await api.testImap(BRAND, {
      host: 'imap.example.com',
      port: 993,
      security: 'tls',
      username: 'u',
      folder: 'INBOX',
      mailboxId: MAILBOX,
    });

    expect(result).toMatchObject({ ok: false, kind: 'auth' });
    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND}/mailboxes/test-imap`,
      method: 'POST',
    });
  });

  it('reads the inbound-parse card and replaces its secret', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ secretSet: true, secretUpdatedAt: null, lastRequest: null }),
    );
    expect((await api.inboundParse(BRAND)).secretSet).toBe(true);

    fetchMock.mockResolvedValueOnce(json({ secret: 'new-secret' }));
    expect(await api.replaceInboundSecret(BRAND)).toEqual({ secret: 'new-secret' });
    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND}/inbound-parse/secret`,
      method: 'POST',
    });
  });

  it('fetches a remote image through the proxy with the access token, as a data URL', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/webp' },
      }),
    );

    const url = await api.remoteImage(BRAND, TICKET, MESSAGE, 1);

    expect(url).toMatch(/^data:image\/webp;base64,/);
    expect(lastCall().url).toBe(
      `/api/brands/${BRAND}/tickets/${TICKET}/messages/${MESSAGE}/remote-images/1`,
    );
  });

  it('turns a mailbox refusal into a ChannelsError carrying its reason', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: 'taken',
            requestId: 'r1',
            channels: { reason: 'address-taken' },
          },
        },
        409,
      ),
    );

    const error = await api
      .createMailbox(BRAND, {
        address: 'a@b.co',
        displayName: 'A',
        departmentId: mailbox.departmentId,
        method: 'inbound_parse',
        remoteImages: 'block',
        authFailureIsSpam: false,
        automatedAllowlist: [],
      })
      .catch((caught: unknown) => caught);

    expect(isChannelsError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'address-taken' });
  });

  it('refreshes once and retries an image the token had expired for', async () => {
    const transport = new HttpTransport();
    transport.accessToken = 'old';
    const refreshing = new HttpChannelsApi(transport);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(refreshing.remoteImage(BRAND, TICKET, MESSAGE, 0)).rejects.toMatchObject({
      name: 'AuthError',
    });
  });
});
