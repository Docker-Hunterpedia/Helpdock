import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isMetaError } from './api.js';
import { HttpMetaApi } from './http-api.js';
import {
  MOCK_MESSENGER_ACCOUNT,
  MOCK_MESSENGER_TOKEN,
  MOCK_NEW_MESSENGER_PAGE_ID,
  MockMetaApi,
} from './mock-api.js';

/**
 * The Meta adapter against a stubbed `fetch`: the paths and bodies it sends,
 * what it parses, and what a refusal becomes. That the routes behave is
 * `meta-accounts.integration.test.ts` in the api.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const DEPARTMENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpMetaApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpMetaApi(new HttpTransport());
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

describe('HttpMetaApi', () => {
  it('reads the install’s Meta app and asks for a new verify token', async () => {
    const app = await new MockMetaApi().app();

    fetchMock.mockResolvedValueOnce(json(app));
    expect(await api.app()).toEqual(app);
    expect(lastCall()).toMatchObject({ url: '/api/meta/app', method: 'GET' });

    fetchMock.mockResolvedValueOnce(json({ verifyToken: 'hd_mvt_abc' }));
    expect(await api.rotateVerifyToken()).toEqual({ verifyToken: 'hd_mvt_abc' });
    expect(lastCall()).toMatchObject({ url: '/api/meta/app/verify-token', method: 'POST' });
  });

  it('lists, reads, connects, saves and disconnects accounts', async () => {
    const account = await new MockMetaApi().account(BRAND, MOCK_MESSENGER_ACCOUNT);
    const accounts = `/api/brands/${BRAND}/meta/accounts`;

    fetchMock.mockResolvedValueOnce(json({ accounts: [account] }));
    expect((await api.accounts(BRAND)).accounts).toHaveLength(1);
    expect(lastCall()).toMatchObject({ url: accounts, method: 'GET' });

    fetchMock.mockResolvedValueOnce(json(account));
    await api.account(BRAND, account.id);
    expect(lastCall()).toMatchObject({ url: `${accounts}/${account.id}`, method: 'GET' });

    const connect = {
      platform: 'messenger',
      externalId: MOCK_NEW_MESSENGER_PAGE_ID,
      accessToken: MOCK_MESSENGER_TOKEN,
      departmentId: DEPARTMENT,
      humanAgentEnabled: false,
    } as const;
    fetchMock.mockResolvedValueOnce(json(account, 201));
    await api.createAccount(BRAND, connect);
    expect(lastCall()).toMatchObject({ method: 'POST', url: accounts, body: connect });

    const update = { displayName: 'Helpdock', departmentId: DEPARTMENT, humanAgentEnabled: true };
    fetchMock.mockResolvedValueOnce(json(account));
    await api.updateAccount(BRAND, account.id, update);
    expect(lastCall()).toMatchObject({
      method: 'PUT',
      url: `${accounts}/${account.id}`,
      body: update,
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteAccount(BRAND, account.id);
    expect(lastCall()).toMatchObject({ method: 'DELETE', url: `${accounts}/${account.id}` });
  });

  it('tests a typed token and a stored one, subscribes and reads the status', async () => {
    const accounts = `/api/brands/${BRAND}/meta/accounts`;
    const status = await new MockMetaApi().status(BRAND, MOCK_MESSENGER_ACCOUNT);
    const request = {
      platform: 'messenger',
      externalId: MOCK_NEW_MESSENGER_PAGE_ID,
      accessToken: MOCK_MESSENGER_TOKEN,
    } as const;

    fetchMock.mockResolvedValueOnce(json({ ok: false, kind: 'token', detail: '(190)' }));
    expect(await api.testToken(BRAND, request)).toMatchObject({ ok: false, kind: 'token' });
    expect(lastCall()).toMatchObject({ method: 'POST', url: `${accounts}/test`, body: request });

    fetchMock.mockResolvedValueOnce(
      json({ ok: true, platform: 'messenger', externalId: '1', name: 'Acme' }),
    );
    await api.testAccount(BRAND, MOCK_MESSENGER_ACCOUNT);
    expect(lastCall()).toMatchObject({ url: `${accounts}/${MOCK_MESSENGER_ACCOUNT}/test` });

    fetchMock.mockResolvedValueOnce(json({ ok: false, detail: 'not allowed' }));
    expect(await api.subscribe(BRAND, MOCK_MESSENGER_ACCOUNT)).toEqual({
      ok: false,
      detail: 'not allowed',
    });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      url: `${accounts}/${MOCK_MESSENGER_ACCOUNT}/subscribe`,
    });

    fetchMock.mockResolvedValueOnce(json(status));
    expect((await api.status(BRAND, MOCK_MESSENGER_ACCOUNT)).activity.openTickets).toBe(9);
    expect(lastCall()).toMatchObject({ url: `${accounts}/${MOCK_MESSENGER_ACCOUNT}/status` });
  });

  it('turns a Meta refusal into a MetaError carrying its reason', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: 'taken',
            requestId: 'r1',
            meta: { reason: 'account-taken' },
          },
        },
        409,
      ),
    );

    const error = await api
      .createAccount(BRAND, {
        platform: 'messenger',
        externalId: MOCK_NEW_MESSENGER_PAGE_ID,
        accessToken: MOCK_MESSENGER_TOKEN,
        departmentId: DEPARTMENT,
        humanAgentEnabled: false,
      })
      .catch((caught: unknown) => caught);

    expect(isMetaError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'account-taken' });
  });
});

describe('HttpMetaApi, the ticket’s half (M10-08)', () => {
  const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000001040';
  const DELIVERY = '0192c3f0-1a2b-7c3d-8e4f-0000000a0011';
  const path = `/api/brands/${BRAND}/tickets/${TICKET}/meta`;

  it('reads the context, the deliveries and what was unsent in one request', async () => {
    const read = await new MockMetaApi().ticketContext(BRAND, TICKET);

    fetchMock.mockResolvedValueOnce(json(read));
    const answered = await api.ticketContext(BRAND, TICKET);

    expect(lastCall()).toMatchObject({ url: path, method: 'GET' });
    expect(answered.context?.account.platform).toBe('whatsapp');
    expect(answered.deliveries.length).toBeGreaterThan(0);
  });

  it('reads an answer from before the api sent what was unsent as nothing unsent', async () => {
    fetchMock.mockResolvedValueOnce(json({ context: null, deliveries: [] }));

    expect(await api.ticketContext(BRAND, TICKET)).toEqual({
      context: null,
      deliveries: [],
      unsent: [],
    });
  });

  it('posts Retry to the delivery and takes the 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await api.retryDelivery(BRAND, TICKET, DELIVERY);

    expect(lastCall()).toMatchObject({
      url: `${path}/deliveries/${DELIVERY}/retry`,
      method: 'POST',
    });
  });

  it('carries where the window stands when a reply is refused for it', async () => {
    const details = {
      platform: 'whatsapp',
      anchorAt: '2026-10-10T08:00:00.000Z',
      closedAt: '2026-10-11T08:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: 'The customer’s reply window is closed',
            requestId: 'r2',
            meta: { reason: 'reply-window-closed', details },
          },
        },
        409,
      ),
    );

    const error = await api
      .retryDelivery(BRAND, TICKET, DELIVERY)
      .catch((caught: unknown) => caught);

    expect(isMetaError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'reply-window-closed', details });
  });
});
