import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isTelegramError } from './api.js';
import { HttpTelegramApi } from './http-api.js';
import { MOCK_SUPPORT_BOT, MockTelegramApi } from './mock-api.js';

/**
 * The Telegram adapter against a stubbed `fetch`: the paths and bodies it
 * sends, what it parses, and what a refusal becomes. That the routes behave is
 * `telegram.integration.test.ts` in the api.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000001039';
const DELIVERY = '0192c3f0-1a2b-7c3d-8e4f-0000000007d2';
const TOKEN = '7310042299:AAEnewBotTokenForTheFixtureAbcdefgh';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpTelegramApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpTelegramApi(new HttpTransport());
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

describe('HttpTelegramApi', () => {
  it('lists, reads, creates, saves and deletes bots', async () => {
    const bot = await new MockTelegramApi().bot(BRAND, MOCK_SUPPORT_BOT);
    const bots = `/api/brands/${BRAND}/telegram/bots`;

    fetchMock.mockResolvedValueOnce(json({ bots: [bot] }));
    expect((await api.bots(BRAND)).bots).toHaveLength(1);
    expect(lastCall()).toMatchObject({ url: bots, method: 'GET' });

    fetchMock.mockResolvedValueOnce(json(bot));
    await api.bot(BRAND, bot.id);
    expect(lastCall()).toMatchObject({ url: `${bots}/${bot.id}`, method: 'GET' });

    const request = {
      displayName: 'Helpdock Support',
      departmentId: bot.departmentId,
      welcomeEn: null,
      welcomeAr: null,
      languagePick: true,
    };
    fetchMock.mockResolvedValueOnce(json(bot, 201));
    await api.createBot(BRAND, { ...request, token: TOKEN });
    expect(lastCall()).toMatchObject({ method: 'POST', body: { token: TOKEN } });

    fetchMock.mockResolvedValueOnce(json(bot));
    await api.updateBot(BRAND, bot.id, request);
    expect(lastCall()).toMatchObject({ method: 'PUT', url: `${bots}/${bot.id}`, body: request });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteBot(BRAND, bot.id);
    expect(lastCall()).toMatchObject({ method: 'DELETE', url: `${bots}/${bot.id}` });
  });

  it('tests a typed token and a saved one, sets the webhook and reads the status', async () => {
    const bots = `/api/brands/${BRAND}/telegram/bots`;
    const status = await new MockTelegramApi().status(BRAND, MOCK_SUPPORT_BOT);

    fetchMock.mockResolvedValueOnce(
      json({ ok: false, kind: 'token', detail: '401: Unauthorized' }),
    );
    expect(await api.testToken(BRAND, TOKEN)).toMatchObject({ ok: false, kind: 'token' });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      url: `${bots}/test`,
      body: { token: TOKEN },
    });

    fetchMock.mockResolvedValueOnce(
      json({ ok: true, username: 'acme_bot', name: 'Acme', telegramId: 7 }),
    );
    await api.testBot(BRAND, MOCK_SUPPORT_BOT);
    expect(lastCall()).toMatchObject({ url: `${bots}/${MOCK_SUPPORT_BOT}/test` });

    fetchMock.mockResolvedValueOnce(json({ ok: false, detail: 'bad url' }));
    expect(await api.setWebhook(BRAND, MOCK_SUPPORT_BOT)).toEqual({ ok: false, detail: 'bad url' });
    expect(lastCall()).toMatchObject({ url: `${bots}/${MOCK_SUPPORT_BOT}/webhook` });

    fetchMock.mockResolvedValueOnce(json(status));
    expect((await api.status(BRAND, MOCK_SUPPORT_BOT)).activity.openTickets).toBe(14);
    expect(lastCall()).toMatchObject({ url: `${bots}/${MOCK_SUPPORT_BOT}/status` });
  });

  it('reads a ticket’s chat and retries a delivery', async () => {
    const ticket = `/api/brands/${BRAND}/tickets/${TICKET}`;

    fetchMock.mockResolvedValueOnce(json({ context: null, deliveries: [] }));
    expect(await api.ticketContext(BRAND, TICKET)).toEqual({ context: null, deliveries: [] });
    expect(lastCall()).toMatchObject({ url: `${ticket}/telegram`, method: 'GET' });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.retryDelivery(BRAND, TICKET, DELIVERY);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      url: `${ticket}/telegram/deliveries/${DELIVERY}/retry`,
    });
  });

  it('turns a Telegram refusal into a TelegramError carrying its reason', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: 'taken',
            requestId: 'r1',
            telegram: { reason: 'bot-taken' },
          },
        },
        409,
      ),
    );

    const error = await api
      .createBot(BRAND, {
        displayName: 'x',
        departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
        token: TOKEN,
        welcomeEn: null,
        welcomeAr: null,
        languagePick: true,
      })
      .catch((caught: unknown) => caught);

    expect(isTelegramError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'bot-taken' });
  });
});
