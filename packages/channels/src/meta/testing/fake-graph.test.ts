import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../fixtures.js';
import { FakeGraph } from './fake-graph.js';

/**
 * The stand-in's own suite: it is a piece of test infrastructure every M10
 * suite leans on, so what it answers is pinned here, with plain `fetch` and
 * no help from the Graph client.
 */

const WA_TOKEN = 'WA-TOKEN-0123456789abcdef';
const PAGE_TOKEN = 'PAGE-TOKEN-0123456789abcdef';
const IG_TOKEN = 'IG-TOKEN-0123456789abcdef';
const PHONE_ID = '106540352242922';
const WABA_ID = '102290129340398';
const PAGE_ID = '112233445566778';
const IG_ID = '17841400000000000';
const CUSTOMER = '16505551234';
const PSID = '7654321098765432';
const IGSID = '17841499999999999';

const NOW = new Date('2026-10-11T08:00:00.000Z');
let clock = NOW;

const graph = new FakeGraph({ now: () => clock });

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Headers;
}

const call = async (
  method: string,
  url: string,
  {
    token,
    body,
    query,
  }: { token?: string | null; body?: unknown; query?: Record<string, string> } = {},
): Promise<Reply> => {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query ?? {})) {
    target.searchParams.set(key, value);
  }
  const response = await fetch(target, {
    method,
    headers: {
      ...(token === null || token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  return {
    status: response.status,
    json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
};

const fb = (path: string): string => `${graph.facebookRoot}/v25.0${path}`;
const ig = (path: string): string => `${graph.instagramRoot}/v25.0${path}`;

const errorOf = (reply: Reply): Record<string, unknown> =>
  reply.json.error as Record<string, unknown>;

const waText = (to: string, body = 'Hello') => ({
  messaging_product: 'whatsapp',
  to,
  type: 'text',
  text: { body },
});

const messagingText = (id: string, text = 'Hello') => ({
  recipient: { id },
  messaging_type: 'RESPONSE',
  message: { text },
});

beforeAll(async () => {
  await graph.start();
});

afterAll(async () => {
  await graph.stop();
});

beforeEach(() => {
  graph.reset();
  clock = NOW;
  graph.connect({
    platform: 'whatsapp',
    id: PHONE_ID,
    name: 'Acme Support',
    displayPhone: '+1 555 078 3881',
    wabaId: WABA_ID,
    token: WA_TOKEN,
  });
  graph.connect({ platform: 'messenger', id: PAGE_ID, name: 'Acme Page', token: PAGE_TOKEN });
  graph.connect({
    platform: 'instagram',
    id: IG_ID,
    name: 'Acme',
    username: 'acme',
    token: IG_TOKEN,
    expiresAt: new Date(NOW.getTime() + 8 * 86_400_000),
  });
});

describe('the roots', () => {
  it('serves two roots on one address, as the two environment variables name them', () => {
    expect(graph.facebookRoot).toBe(`${graph.url}/facebook`);
    expect(graph.instagramRoot).toBe(`${graph.url}/instagram`);
    expect(graph.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('records which root served a call, the version, the token and the query', async () => {
    await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN, query: { fields: 'id' } });
    await call('GET', ig('/me'), { token: IG_TOKEN });

    expect(graph.calls).toMatchObject([
      {
        root: 'facebook',
        method: 'GET',
        path: `/${PHONE_ID}`,
        version: 'v25.0',
        token: WA_TOKEN,
        query: { fields: 'id' },
      },
      { root: 'instagram', method: 'GET', path: '/me', version: 'v25.0', token: IG_TOKEN },
    ]);
  });

  it('reads the token from access_token as well as from the bearer', async () => {
    const reply = await call('GET', fb(`/${PHONE_ID}`), { query: { access_token: WA_TOKEN } });

    expect(reply.status).toBe(200);
    expect(graph.calls[0]?.token).toBe(WA_TOKEN);
  });

  it('refuses a token on the root it was not issued for: an Instagram token is no good on Facebook’s', async () => {
    const reply = await call('GET', fb(`/${IG_ID}`), { token: IG_TOKEN });

    expect(reply.status).toBe(401);
    expect(errorOf(reply).code).toBe(190);
  });

  it('answers a path it does not know with Graph’s own 100', async () => {
    const reply = await call('GET', `${graph.url}/nowhere`, { token: WA_TOKEN });

    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe(100);
  });
});

describe('tokens', () => {
  it('answers a token it does not know, and no token at all, with 401 and 190', async () => {
    for (const token of ['nobody-0123456789abcdef', null]) {
      const reply = await call('GET', fb(`/${PHONE_ID}`), { token });

      expect(reply.status).toBe(401);
      expect(errorOf(reply)).toMatchObject({ code: 190, type: 'OAuthException' });
    }
  });

  it('answers a token it was told has expired with 400, 190 and sub-code 463', async () => {
    graph.expiredTokens.add(WA_TOKEN);
    const reply = await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN });

    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toMatchObject({ code: 190, error_subcode: 463 });
  });

  it('expires a token by the clock it was given', async () => {
    expect((await call('GET', ig(`/${IG_ID}`), { token: IG_TOKEN })).status).toBe(200);

    clock = new Date(NOW.getTime() + 9 * 86_400_000);

    expect(errorOf(await call('GET', ig(`/${IG_ID}`), { token: IG_TOKEN })).code).toBe(190);
  });

  it('lets a test move an expiry, or remove it', async () => {
    graph.setTokenExpiry(IG_TOKEN, new Date(NOW.getTime() - 1_000));
    expect((await call('GET', ig(`/${IG_ID}`), { token: IG_TOKEN })).status).toBe(400);

    graph.setTokenExpiry(IG_TOKEN, null);
    expect((await call('GET', ig(`/${IG_ID}`), { token: IG_TOKEN })).status).toBe(200);
    expect(() => graph.setTokenExpiry('unknown', null)).toThrow('No such token');
  });

  it('refuses to put one token on both roots', () => {
    expect(() =>
      graph.connect({ platform: 'instagram', id: '999', name: 'x', token: WA_TOKEN }),
    ).toThrow('one root only');
  });

  it('lets one system-user token open two WhatsApp numbers', async () => {
    graph.connect({
      platform: 'whatsapp',
      id: '222',
      name: 'Second',
      wabaId: WABA_ID,
      token: WA_TOKEN,
    });

    expect((await call('GET', fb('/222'), { token: WA_TOKEN })).status).toBe(200);
    expect((await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN })).status).toBe(200);
  });

  it('will not connect a WhatsApp number without its business account, so no fixture forgets it', () => {
    expect(() =>
      graph.connect({
        platform: 'whatsapp',
        id: '333',
        name: 'Orphan',
        token: 'orphan-token-0123456',
      }),
    ).toThrow('wabaId');
  });
});

describe('who an account is', () => {
  it('answers a WhatsApp number with its verified name and number', async () => {
    const reply = await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN });

    expect(reply.json).toEqual({
      id: PHONE_ID,
      display_phone_number: '+1 555 078 3881',
      verified_name: 'Acme Support',
    });
  });

  it('answers a Page with its name, and an Instagram account with its handle', async () => {
    expect((await call('GET', fb(`/${PAGE_ID}`), { token: PAGE_TOKEN })).json).toEqual({
      id: PAGE_ID,
      name: 'Acme Page',
    });
    expect((await call('GET', ig(`/${IG_ID}`), { token: IG_TOKEN })).json).toEqual({
      id: IG_ID,
      username: 'acme',
      name: 'Acme',
    });
  });

  it('answers /me with the account of the token', async () => {
    expect((await call('GET', fb('/me'), { token: PAGE_TOKEN })).json).toMatchObject({
      id: PAGE_ID,
    });
    expect((await call('GET', ig('/me'), { token: IG_TOKEN })).json).toMatchObject({ id: IG_ID });
  });

  it('returns only the fields asked for, and always the id', async () => {
    const reply = await call('GET', ig(`/${IG_ID}`), {
      token: IG_TOKEN,
      query: { fields: 'username' },
    });

    expect(reply.json).toEqual({ id: IG_ID, username: 'acme' });
  });

  it('refuses an id the token does not open, as Graph does for a missing permission', async () => {
    const reply = await call('GET', fb(`/${PAGE_ID}`), { token: WA_TOKEN });

    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe(100);
    expect((await call('GET', fb('/123456'), { token: WA_TOKEN })).status).toBe(400);
  });
});

describe('sending', () => {
  it('accepts a WhatsApp text and answers with a wamid, the recipient and the platform', async () => {
    const reply = await call('POST', fb(`/${PHONE_ID}/messages`), {
      token: WA_TOKEN,
      body: waText(`+${CUSTOMER}`, 'Hello'),
    });

    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      messaging_product: 'whatsapp',
      contacts: [{ input: `+${CUSTOMER}`, wa_id: CUSTOMER }],
      messages: [{ id: expect.stringMatching(/^wamid\./) }],
    });
    expect(graph.sent).toHaveLength(1);
    expect(graph.sent[0]).toMatchObject({
      accountId: PHONE_ID,
      platform: 'whatsapp',
      to: `+${CUSTOMER}`,
    });
  });

  it('accepts a Messenger text and an Instagram text and answers with a message id', async () => {
    const messenger = await call('POST', fb(`/${PAGE_ID}/messages`), {
      token: PAGE_TOKEN,
      body: messagingText(PSID),
    });
    const instagram = await call('POST', ig(`/${IG_ID}/messages`), {
      token: IG_TOKEN,
      body: messagingText(IGSID),
    });

    expect(messenger.json).toMatchObject({
      recipient_id: PSID,
      message_id: expect.stringMatching(/^m_/),
    });
    expect(instagram.json).toMatchObject({
      recipient_id: IGSID,
      message_id: expect.stringMatching(/^m_/),
    });
    expect(graph.sent.map((message) => message.platform)).toEqual(['messenger', 'instagram']);
  });

  it('gives every accepted message an id of its own', async () => {
    for (let n = 0; n < 3; n += 1) {
      await call('POST', fb(`/${PAGE_ID}/messages`), {
        token: PAGE_TOKEN,
        body: messagingText(PSID),
      });
    }

    expect(new Set(graph.sent.map((message) => message.id)).size).toBe(3);
  });

  it('accepts an uploaded WhatsApp file by id and a Messenger attachment by URL', async () => {
    const whatsapp = await call('POST', fb(`/${PHONE_ID}/messages`), {
      token: WA_TOKEN,
      body: {
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'document',
        document: { id: 'FAKEMEDIA000001', filename: 'invoice.pdf', caption: 'Your invoice' },
      },
    });
    const messenger = await call('POST', fb(`/${PAGE_ID}/messages`), {
      token: PAGE_TOKEN,
      body: {
        recipient: { id: PSID },
        messaging_type: 'RESPONSE',
        message: {
          attachment: {
            type: 'image',
            payload: { url: 'https://files.example.com/a.png', is_reusable: false },
          },
        },
      },
    });

    expect(whatsapp.status).toBe(200);
    expect(messenger.status).toBe(200);
  });

  it('keeps the exact body Helpdock sent, for a test to read', async () => {
    const body = messagingText(PSID, 'Exactly this');
    await call('POST', fb(`/${PAGE_ID}/messages`), { token: PAGE_TOKEN, body });

    expect(graph.callsTo('/messages', 'POST')[0]?.body).toEqual(body);
    expect(graph.sent[0]?.payload).toEqual(body);
  });

  it('refuses a body Graph would refuse: unknown fields, text and attachment together, a tag without its type', async () => {
    const bodies = [
      { ...waText(CUSTOMER), surprise: true },
      { messaging_product: 'whatsapp', type: 'text', text: { body: 'no recipient' } },
      {
        recipient: { id: PSID },
        message: {
          text: 'both',
          attachment: { type: 'image', payload: { url: 'https://x.test/a.png' } },
        },
      },
      { recipient: { id: PSID }, tag: 'HUMAN_AGENT', message: { text: 'tag alone' } },
    ];
    const [whatsapp, noRecipient, both, tag] = await Promise.all([
      call('POST', fb(`/${PHONE_ID}/messages`), { token: WA_TOKEN, body: bodies[0] }),
      call('POST', fb(`/${PHONE_ID}/messages`), { token: WA_TOKEN, body: bodies[1] }),
      call('POST', fb(`/${PAGE_ID}/messages`), { token: PAGE_TOKEN, body: bodies[2] }),
      call('POST', fb(`/${PAGE_ID}/messages`), { token: PAGE_TOKEN, body: bodies[3] }),
    ]);

    for (const reply of [whatsapp, noRecipient, both, tag]) {
      expect(reply.status).toBe(400);
      expect(errorOf(reply).code).toBe(100);
    }
    expect(graph.sent).toEqual([]);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await fetch(fb(`/${PAGE_ID}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${PAGE_TOKEN}`, 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
  });

  it('holds a text to its platform’s limit: 4096 characters, 2000 characters, 1000 bytes', async () => {
    const whatsapp = (size: number) =>
      call('POST', fb(`/${PHONE_ID}/messages`), {
        token: WA_TOKEN,
        body: waText(CUSTOMER, 'a'.repeat(size)),
      });
    const messenger = (size: number) =>
      call('POST', fb(`/${PAGE_ID}/messages`), {
        token: PAGE_TOKEN,
        body: messagingText(PSID, 'a'.repeat(size)),
      });
    const instagram = (text: string) =>
      call('POST', ig(`/${IG_ID}/messages`), { token: IG_TOKEN, body: messagingText(IGSID, text) });

    expect((await whatsapp(4_096)).status).toBe(200);
    expect((await whatsapp(4_097)).status).toBe(400);
    expect((await messenger(2_000)).status).toBe(200);
    expect((await messenger(2_001)).status).toBe(400);
    expect((await instagram('ب'.repeat(500))).status).toBe(200);
    expect((await instagram('ب'.repeat(501))).status).toBe(400);
    expect((await instagram('a'.repeat(1_001))).status).toBe(400);
  });

  it('refuses an account the token does not open', async () => {
    const reply = await call('POST', fb(`/${PAGE_ID}/messages`), {
      token: WA_TOKEN,
      body: messagingText(PSID),
    });

    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe(100);
  });

  it('refuses an Instagram send on the Facebook root, so a wrong root fails a test', async () => {
    const reply = await call('POST', fb(`/${IG_ID}/messages`), {
      token: IG_TOKEN,
      body: messagingText(IGSID),
    });

    expect(reply.status).toBe(401);
  });
});

describe('refusing a customer, as Meta does', () => {
  it('answers a closed WhatsApp window with 131047, whether the number has a plus or not', async () => {
    graph.windowClosed.add(CUSTOMER);

    for (const to of [CUSTOMER, `+${CUSTOMER}`]) {
      const reply = await call('POST', fb(`/${PHONE_ID}/messages`), {
        token: WA_TOKEN,
        body: waText(to),
      });

      expect(reply.status).toBe(400);
      expect(errorOf(reply)).toMatchObject({ code: 131_047 });
    }
    expect(graph.sent).toEqual([]);
  });

  it('answers a closed Messenger or Instagram window with 10 and sub-code 2018278', async () => {
    graph.windowClosed.add(PSID).add(IGSID);
    const messenger = await call('POST', fb(`/${PAGE_ID}/messages`), {
      token: PAGE_TOKEN,
      body: messagingText(PSID),
    });
    const instagram = await call('POST', ig(`/${IG_ID}/messages`), {
      token: IG_TOKEN,
      body: messagingText(IGSID),
    });

    expect(errorOf(messenger)).toMatchObject({ code: 10, error_subcode: 2_018_278 });
    expect(errorOf(instagram)).toMatchObject({ code: 10, error_subcode: 2_018_278 });
  });

  it('answers a pair-limited number with 131056, and a blocked one with 551', async () => {
    graph.pairLimited.add(CUSTOMER);
    graph.blocked.add(PSID);

    expect(
      errorOf(
        await call('POST', fb(`/${PHONE_ID}/messages`), {
          token: WA_TOKEN,
          body: waText(CUSTOMER),
        }),
      ).code,
    ).toBe(131_056);
    expect(
      errorOf(
        await call('POST', fb(`/${PAGE_ID}/messages`), {
          token: PAGE_TOKEN,
          body: messagingText(PSID),
        }),
      ).code,
    ).toBe(551);
  });

  it('leaves other customers alone while one is refused', async () => {
    graph.windowClosed.add(CUSTOMER);
    const reply = await call('POST', fb(`/${PHONE_ID}/messages`), {
      token: WA_TOKEN,
      body: waText('447700900123'),
    });

    expect(reply.status).toBe(200);
  });

  it('can be taught to forget a refusal', async () => {
    graph.windowClosed.add(CUSTOMER);
    graph.windowClosed.delete(CUSTOMER);

    expect(
      (await call('POST', fb(`/${PHONE_ID}/messages`), { token: WA_TOKEN, body: waText(CUSTOMER) }))
        .status,
    ).toBe(200);
  });
});

describe('bodies as Meta’s reference writes them', () => {
  // Literal requests, copied from the shapes Meta documents for `POST /{id}/messages` and
  // not built from Helpdock's own schemas, so a field Helpdock got wrong is refused here too.
  it('accepts the WhatsApp text, image, document and audio bodies of the reference', async () => {
    const bodies = [
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: CUSTOMER,
        type: 'text',
        text: { preview_url: false, body: 'text-message-content' },
      },
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: CUSTOMER,
        type: 'image',
        image: { id: 'your-media-id', caption: 'your-image-caption' },
      },
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: CUSTOMER,
        type: 'document',
        document: { id: 'your-media-id', caption: 'your-document-caption', filename: 'file-name' },
      },
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: CUSTOMER,
        type: 'audio',
        audio: { id: 'your-media-id' },
      },
    ];

    for (const body of bodies) {
      expect(
        (await call('POST', fb(`/${PHONE_ID}/messages`), { token: WA_TOKEN, body })).status,
      ).toBe(200);
    }
  });

  it('accepts the Messenger text, attachment and tagged bodies of the reference', async () => {
    graph.lastCustomerMessage.set(PSID, new Date(NOW.getTime() - 3 * 86_400_000));
    const bodies = [
      {
        recipient: { id: PSID },
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
        message: { text: 'hello' },
      },
      {
        recipient: { id: PSID },
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
        message: {
          attachment: {
            type: 'image',
            payload: { url: 'https://www.example.com/image.png', is_reusable: true },
          },
        },
      },
    ];

    for (const body of bodies) {
      expect(
        (await call('POST', fb(`/${PAGE_ID}/messages`), { token: PAGE_TOKEN, body })).status,
      ).toBe(200);
    }
  });

  it('refuses what Meta refuses: a caption on audio, a file name on an image, an unknown message_type', async () => {
    const refused = [
      {
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'audio',
        audio: { id: 'your-media-id', caption: 'no captions on audio' },
      },
      {
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'image',
        image: { id: 'your-media-id', filename: 'no file names on images' },
      },
    ];
    for (const body of refused) {
      expect(
        (await call('POST', fb(`/${PHONE_ID}/messages`), { token: WA_TOKEN, body })).status,
      ).toBe(400);
    }
    expect(
      (
        await call('POST', fb(`/${PAGE_ID}/messages`), {
          token: PAGE_TOKEN,
          body: { recipient: { id: PSID }, message_type: 'RESPONSE', message: { text: 'hello' } },
        })
      ).status,
    ).toBe(400);
  });
});

describe('the windows of a customer who wrote', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const wroteAgo = (ms: number): Date => new Date(NOW.getTime() - ms);
  const tagged = (id: string, text = 'Still looking into it') => ({
    recipient: { id },
    messaging_type: 'MESSAGE_TAG',
    tag: 'HUMAN_AGENT',
    message: { text },
  });
  const sendMessenger = (body: unknown) =>
    call('POST', fb(`/${PAGE_ID}/messages`), { token: PAGE_TOKEN, body });
  const sendInstagram = (body: unknown) =>
    call('POST', ig(`/${IG_ID}/messages`), { token: IG_TOKEN, body });
  const sendWhatsApp = (body: unknown) =>
    call('POST', fb(`/${PHONE_ID}/messages`), { token: WA_TOKEN, body });

  it('takes a free-form reply for 24 hours and refuses it from the instant they have passed', async () => {
    graph.lastCustomerMessage.set(PSID, wroteAgo(24 * HOUR - 1));
    expect((await sendMessenger(messagingText(PSID))).status).toBe(200);

    graph.lastCustomerMessage.set(PSID, wroteAgo(24 * HOUR));
    const late = await sendMessenger(messagingText(PSID));

    expect(late.status).toBe(400);
    expect(errorOf(late)).toMatchObject({ code: 10, error_subcode: 2_018_278 });
  });

  it('refuses a WhatsApp text after 24 hours with 131047, however the number is written', async () => {
    graph.lastCustomerMessage.set(CUSTOMER, wroteAgo(25 * HOUR));

    for (const to of [CUSTOMER, `+${CUSTOMER}`]) {
      const reply = await sendWhatsApp(waText(to));

      expect(reply.status).toBe(400);
      expect(errorOf(reply)).toMatchObject({ code: 131_047 });
    }
  });

  it('does not judge a customer it was never told about, so a suite that ignores the window need not set one', async () => {
    expect((await sendMessenger(messagingText(PSID))).status).toBe(200);
  });

  it.each([
    ['Messenger', sendMessenger, PSID],
    ['Instagram', sendInstagram, IGSID],
  ] as const)(
    'takes the Human Agent tag on %s for seven days after the customer’s last message',
    async (_name, send, customer) => {
      graph.lastCustomerMessage.set(customer, wroteAgo(3 * DAY));

      const reply = await send(tagged(customer));

      expect(reply.status).toBe(200);
      expect(graph.sent.at(-1)?.payload).toMatchObject({
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
      });
    },
  );

  it.each([
    ['Messenger', sendMessenger, PSID],
    ['Instagram', sendInstagram, IGSID],
  ] as const)(
    'refuses the tag on %s from the seventh day, with the closed-window error',
    async (_name, send, customer) => {
      graph.lastCustomerMessage.set(customer, wroteAgo(7 * DAY - 1));
      expect((await send(tagged(customer))).status).toBe(200);

      graph.lastCustomerMessage.set(customer, wroteAgo(7 * DAY));
      const late = await send(tagged(customer));

      expect(late.status).toBe(400);
      expect(errorOf(late)).toMatchObject({ code: 10, error_subcode: 2_018_278 });
    },
  );

  it('refuses the tag for a customer who never wrote: it extends a window, it does not open one', async () => {
    const reply = await sendMessenger(tagged(PSID));

    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toMatchObject({ code: 10, error_subcode: 2_018_278 });
    expect(graph.sent).toEqual([]);
  });

  it('refuses the tag on WhatsApp, which has no such parameter', async () => {
    graph.lastCustomerMessage.set(CUSTOMER, wroteAgo(3 * DAY));

    const reply = await sendWhatsApp({
      ...waText(CUSTOMER),
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
    });

    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toMatchObject({ code: 100 });
    expect(graph.sent).toEqual([]);
  });

  it('refuses an untagged reply on day 3 even though the tagged one would have gone', async () => {
    graph.lastCustomerMessage.set(PSID, wroteAgo(3 * DAY));

    expect((await sendMessenger(messagingText(PSID))).status).toBe(400);
    expect((await sendMessenger(tagged(PSID))).status).toBe(200);
  });

  it('judges the customer by the clock it was given', async () => {
    graph.lastCustomerMessage.set(PSID, wroteAgo(HOUR));
    clock = new Date(NOW.getTime() + 24 * HOUR);

    expect((await sendMessenger(messagingText(PSID))).status).toBe(400);
  });

  it('forgets when a customer wrote on reset', async () => {
    graph.lastCustomerMessage.set(PSID, wroteAgo(30 * DAY));
    graph.reset();

    expect(graph.lastCustomerMessage.size).toBe(0);
  });
});

describe('queued failures', () => {
  it('answers the next request with the failure, once, then carries on', async () => {
    graph.failures.push({
      status: 503,
      body: { error: { code: 2, message: 'Service unavailable' } },
    });

    const first = await call('POST', fb(`/${PAGE_ID}/messages`), {
      token: PAGE_TOKEN,
      body: messagingText(PSID),
    });
    const second = await call('POST', fb(`/${PAGE_ID}/messages`), {
      token: PAGE_TOKEN,
      body: messagingText(PSID),
    });

    expect(first.status).toBe(503);
    expect(errorOf(first).code).toBe(2);
    expect(second.status).toBe(200);
    expect(graph.calls).toHaveLength(2);
  });

  it('answers only the requests its pattern matches', async () => {
    graph.failures.push({ status: 500, match: /^POST \/\d+\/messages$/ });

    expect((await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN })).status).toBe(200);
    expect(
      (
        await call('POST', fb(`/${PAGE_ID}/messages`), {
          token: PAGE_TOKEN,
          body: messagingText(PSID),
        })
      ).status,
    ).toBe(500);
  });

  it('can carry headers, such as a redirect’s location', async () => {
    graph.failures.push({ status: 302, headers: { location: 'https://elsewhere.test/' } });
    const response = await fetch(fb(`/${PHONE_ID}`), {
      headers: { authorization: `Bearer ${WA_TOKEN}` },
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://elsewhere.test/');
  });
});

describe('the control routes of a suite in another process', () => {
  const control = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${graph.url}/__control/${route}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  it('reads back the app’s subscription on a Page and on a business account, and says nothing for an id it has not', async () => {
    graph.subscribe(PAGE_ID, ['messages']);
    graph.subscribe(WABA_ID);

    expect(await control('GET', `subscriptions/${PAGE_ID}`)).toEqual({
      status: 200,
      json: { fields: ['messages'] },
    });
    expect(await control('GET', `subscriptions/${WABA_ID}`)).toEqual({
      status: 200,
      json: { fields: ['messages'] },
    });
    graph.dropSubscription(PAGE_ID);
    expect((await control('GET', `subscriptions/${PAGE_ID}`)).json).toEqual({ fields: [] });
    expect((await control('GET', 'subscriptions/999')).status).toBe(404);
  });

  it('revokes a token, as Meta does, and gives it back', async () => {
    await control('POST', 'tokens/expire', { token: PAGE_TOKEN });
    const refused = await call('GET', fb(`/${PAGE_ID}`), { token: PAGE_TOKEN });
    await control('POST', 'tokens/restore', { token: PAGE_TOKEN });
    const restored = await call('GET', fb(`/${PAGE_ID}`), { token: PAGE_TOKEN });

    expect(refused.status).toBe(400);
    expect(errorOf(refused).code).toBe(190);
    expect(restored.status).toBe(200);
  });

  it('queues a refusal for the next request its pattern matches', async () => {
    await control('POST', 'failures', {
      status: 403,
      body: { error: { code: 200, message: '(#200) Requires whatsapp_business_management' } },
      match: 'phone_numbers',
    });

    expect((await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN })).status).toBe(200);
    const refused = await call('GET', fb(`/${WABA_ID}/phone_numbers`), { token: WA_TOKEN });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe(200);
    expect((await call('GET', fb(`/${WABA_ID}/phone_numbers`), { token: WA_TOKEN })).status).toBe(
      200,
    );
  });

  it('answers 404 to a route it does not have, and it is no Graph call', async () => {
    expect((await control('POST', 'tokens/forget', { token: PAGE_TOKEN })).status).toBe(404);
    expect((await control('DELETE', 'failures')).status).toBe(404);
    expect(graph.calls).toEqual([]);
  });
});

describe('uploading media', () => {
  const upload = (
    token: string,
    fields: Record<string, string>,
    file: { name: string; type: string; bytes: Buffer } | null,
  ) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    if (file !== null) {
      form.set('file', new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    }

    return fetch(fb(`/${PHONE_ID}/media`), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  };

  it('records the file and its fields and answers with a media id', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake');
    const response = await upload(
      WA_TOKEN,
      { messaging_product: 'whatsapp', type: 'application/pdf' },
      { name: 'invoice.pdf', type: 'application/pdf', bytes },
    );
    const json = (await response.json()) as { id: string };

    expect(response.status).toBe(200);
    expect(json.id).toMatch(/^FAKEMEDIA/);
    expect(graph.uploads.get(json.id)).toEqual({
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      bytes,
    });
    expect(graph.calls[0]?.body).toMatchObject({
      fields: { messaging_product: 'whatsapp', type: 'application/pdf' },
      file: { name: 'invoice.pdf' },
    });
  });

  it('gives each upload an id of its own', async () => {
    const file = { name: 'a.png', type: 'image/png', bytes: Buffer.from('png') };
    const first = (await (await upload(WA_TOKEN, {}, file)).json()) as { id: string };
    const second = (await (await upload(WA_TOKEN, {}, file)).json()) as { id: string };

    expect(first.id).not.toBe(second.id);
  });

  it('refuses an upload without a file, and an upload to an account that is not a WhatsApp number', async () => {
    expect((await upload(WA_TOKEN, { messaging_product: 'whatsapp' }, null)).status).toBe(400);

    const response = await fetch(fb(`/${PAGE_ID}/media`), {
      method: 'POST',
      headers: { authorization: `Bearer ${PAGE_TOKEN}` },
      body: new FormData(),
    });
    expect(response.status).toBe(400);
  });
});

describe('downloading media', () => {
  const bytes = Buffer.from('JPEGDATA'.repeat(100));

  it('answers a media id with a URL on this server, the type, a hex digest and the size', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    const reply = await call('GET', fb('/555'), { token: WA_TOKEN });

    expect(reply.json).toEqual({
      messaging_product: 'whatsapp',
      url: `${graph.url}/media/555`,
      mime_type: 'image/jpeg',
      sha256: sha256Hex(bytes),
      file_size: String(bytes.byteLength),
      id: '555',
    });
  });

  it('serves the bytes at that URL to a bearer that opens an account, and to nobody else', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    const authorised = await fetch(`${graph.url}/media/555`, {
      headers: { authorization: `Bearer ${WA_TOKEN}` },
    });
    const anonymous = await fetch(`${graph.url}/media/555`);
    const stranger = await fetch(`${graph.url}/media/555`, {
      headers: { authorization: 'Bearer nobody-0123456789abcdef' },
    });

    expect(authorised.status).toBe(200);
    expect(Buffer.from(await authorised.arrayBuffer())).toEqual(bytes);
    expect(authorised.headers.get('content-type')).toBe('image/jpeg');
    expect(anonymous.status).toBe(401);
    expect(stranger.status).toBe(401);
  });

  it('records who asked for the bytes, so a test can see a token that should not have gone', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    await fetch(`${graph.url}/media/555`, { headers: { authorization: `Bearer ${WA_TOKEN}` } });

    expect(graph.mediaRequests).toEqual([
      { kind: 'media', name: '555', authorization: `Bearer ${WA_TOKEN}` },
    ]);
  });

  it('answers 404 for media that expired, at the id and at the URL', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    graph.expiredMedia.add('555');

    const meta = await call('GET', fb('/555'), { token: WA_TOKEN });
    const file = await fetch(`${graph.url}/media/555`, {
      headers: { authorization: `Bearer ${WA_TOKEN}` },
    });

    expect(meta.status).toBe(404);
    expect(file.status).toBe(404);
  });

  it('serves a CDN attachment with no token, and records that none was sent', async () => {
    const url = graph.serveCdn('photo 1.jpg', bytes, 'image/jpeg');
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(graph.mediaRequests).toEqual([
      { kind: 'cdn', name: 'photo 1.jpg', authorization: null },
    ]);
  });

  it('answers 404 for a CDN name it does not hold, and for one that expired', async () => {
    expect((await fetch(`${graph.url}/cdn/missing.jpg`)).status).toBe(404);

    const url = graph.serveCdn('old.jpg', bytes, 'image/jpeg');
    graph.expiredMedia.add('old.jpg');
    expect((await fetch(url)).status).toBe(404);
  });
});

describe('a customer’s profile', () => {
  it('answers the fields asked for', async () => {
    graph.profiles.set(PSID, { first_name: 'Mona', last_name: 'Khalil' });

    expect(
      (
        await call('GET', fb(`/${PSID}`), {
          token: PAGE_TOKEN,
          query: { fields: 'first_name,last_name' },
        })
      ).json,
    ).toEqual({
      id: PSID,
      first_name: 'Mona',
      last_name: 'Khalil',
    });
    expect(
      (await call('GET', fb(`/${PSID}`), { token: PAGE_TOKEN, query: { fields: 'first_name' } }))
        .json,
    ).toEqual({
      id: PSID,
      first_name: 'Mona',
    });
  });

  it('refuses a profile it was told to withhold, as for a Page without the reviewed feature', async () => {
    graph.profiles.set(PSID, { first_name: 'Mona' });
    graph.profileDenied.add(PSID);
    const reply = await call('GET', fb(`/${PSID}`), {
      token: PAGE_TOKEN,
      query: { fields: 'first_name' },
    });

    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe(100);
  });
});

describe('subscribed apps', () => {
  it('lists nobody until the app is subscribed, then lists it with its fields', async () => {
    expect(
      (await call('GET', fb(`/${PAGE_ID}/subscribed_apps`), { token: PAGE_TOKEN })).json,
    ).toEqual({ data: [] });

    const subscribe = await call('POST', fb(`/${PAGE_ID}/subscribed_apps`), {
      token: PAGE_TOKEN,
      query: { subscribed_fields: 'messages,message_echoes' },
    });
    const listed = await call('GET', fb(`/${PAGE_ID}/subscribed_apps`), { token: PAGE_TOKEN });

    expect(subscribe.json).toEqual({ success: true });
    expect(listed.json).toMatchObject({
      data: [
        {
          id: '1234567890123456',
          name: 'Helpdock',
          subscribed_fields: ['messages', 'message_echoes'],
        },
      ],
    });
    expect(graph.subscriptionOf(PAGE_ID)).toEqual(['messages', 'message_echoes']);
  });

  it('subscribes to every field a platform offers when none is named', async () => {
    await call('POST', ig(`/${IG_ID}/subscribed_apps`), { token: IG_TOKEN });

    expect(graph.subscriptionOf(IG_ID)).toContain('messaging_seen');
  });

  it('lists a WhatsApp business account’s app in the wrapper WhatsApp uses', async () => {
    graph.subscribe(WABA_ID);
    const listed = await call('GET', fb(`/${WABA_ID}/subscribed_apps`), { token: WA_TOKEN });

    expect(listed.json).toMatchObject({
      data: [{ whatsapp_business_api_data: { id: '1234567890123456', name: 'Helpdock' } }],
    });
  });

  it('subscribes a business account over HTTP, and the subscription covers every number under it', async () => {
    graph.connect({
      platform: 'whatsapp',
      id: '222',
      name: 'Second',
      wabaId: WABA_ID,
      token: WA_TOKEN,
    });

    const subscribe = await call('POST', fb(`/${WABA_ID}/subscribed_apps`), { token: WA_TOKEN });

    expect(subscribe.json).toEqual({ success: true });
    expect(graph.subscriptionOf(WABA_ID)).toEqual(['messages']);
    await call('DELETE', fb(`/${WABA_ID}/subscribed_apps`), { token: WA_TOKEN });
    expect(graph.subscriptionOf(WABA_ID)).toEqual([]);
  });

  it.each(['GET', 'POST', 'DELETE'])(
    'answers %s on a phone number’s subscribed_apps with the error for an unsupported edge',
    async (method) => {
      const reply = await call(method, fb(`/${PHONE_ID}/subscribed_apps`), { token: WA_TOKEN });

      expect(reply.status).toBe(400);
      expect(errorOf(reply)).toMatchObject({
        code: 100,
        message: expect.stringContaining(`Unsupported ${method.toLowerCase()} request`),
      });
      expect(graph.subscriptionOf(WABA_ID)).toEqual([]);
    },
  );

  it('keeps a business account’s subscription from a token that does not open it', async () => {
    graph.subscribe(WABA_ID);

    const reply = await call('GET', fb(`/${WABA_ID}/subscribed_apps`), { token: PAGE_TOKEN });

    expect(reply.status).toBe(400);
  });

  it('tells a test that subscribes or drops a WhatsApp number which id to use', () => {
    for (const act of [
      () => graph.subscribe(PHONE_ID),
      () => graph.dropSubscription(PHONE_ID),
      () => graph.subscriptionOf(PHONE_ID),
    ]) {
      expect(act).toThrow(`use ${WABA_ID}, not ${PHONE_ID}`);
    }
  });

  it('drops the app on DELETE, and when a test says Meta did', async () => {
    graph.subscribe(PAGE_ID);
    await call('DELETE', fb(`/${PAGE_ID}/subscribed_apps`), { token: PAGE_TOKEN });
    expect(graph.subscriptionOf(PAGE_ID)).toEqual([]);

    graph.subscribe(PAGE_ID);
    graph.dropSubscription(PAGE_ID);
    expect(
      (await call('GET', fb(`/${PAGE_ID}/subscribed_apps`), { token: PAGE_TOKEN })).json,
    ).toEqual({ data: [] });
  });

  it('refuses to subscribe an account that does not exist', () => {
    expect(() => graph.subscribe('nope')).toThrow('No account nope');
  });
});

describe('debug_token', () => {
  it('describes a good token: valid, its kind, its expiry and the app', async () => {
    const reply = await call('GET', ig('/debug_token'), {
      token: IG_TOKEN,
      query: { input_token: IG_TOKEN },
    });

    expect(reply.json).toMatchObject({
      data: {
        is_valid: true,
        app_id: '1234567890123456',
        type: 'USER',
        expires_at: Math.floor((NOW.getTime() + 8 * 86_400_000) / 1_000),
      },
    });
  });

  it('writes 0 for a token that does not expire', async () => {
    const reply = await call('GET', fb('/debug_token'), {
      token: WA_TOKEN,
      query: { input_token: WA_TOKEN },
    });

    expect(reply.json).toMatchObject({
      data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER' },
    });
  });

  it('names the business accounts a WhatsApp token opens, which is how a number is traced to its own', async () => {
    graph.connect({
      platform: 'whatsapp',
      id: '222',
      name: 'Elsewhere',
      wabaId: '555000111',
      token: WA_TOKEN,
    });

    const reply = await call('GET', fb('/debug_token'), {
      token: WA_TOKEN,
      query: { input_token: WA_TOKEN },
    });

    expect(reply.json).toMatchObject({
      data: {
        granular_scopes: [
          { scope: 'whatsapp_business_management', target_ids: [WABA_ID, '555000111'] },
          { scope: 'whatsapp_business_messaging', target_ids: [WABA_ID, '555000111'] },
        ],
      },
    });
  });

  it('names no business account for a Page or an Instagram token', async () => {
    const page = await call('GET', fb('/debug_token'), {
      token: PAGE_TOKEN,
      query: { input_token: PAGE_TOKEN },
    });
    const instagram = await call('GET', ig('/debug_token'), {
      token: IG_TOKEN,
      query: { input_token: IG_TOKEN },
    });

    expect(page.json.data).not.toHaveProperty('granular_scopes');
    expect(instagram.json.data).not.toHaveProperty('granular_scopes');
  });

  it('says an unknown token is not valid, with Graph’s 190 inside a 200 answer', async () => {
    const reply = await call('GET', fb('/debug_token'), {
      token: WA_TOKEN,
      query: { input_token: 'unknown-0123456789' },
    });

    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      data: { is_valid: false, error: { code: 190, subcode: 467 } },
    });
  });

  it('refuses the whole call when the token that asks has expired', async () => {
    graph.expiredTokens.add(WA_TOKEN);
    const reply = await call('GET', fb('/debug_token'), {
      token: WA_TOKEN,
      query: { input_token: WA_TOKEN },
    });

    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe(190);
  });
});

describe('the numbers under a business account', () => {
  it('lists the numbers connected under it with their name, number and rating', async () => {
    graph.connect({
      platform: 'whatsapp',
      id: '222',
      name: 'Second',
      displayPhone: '+1 555 078 3882',
      wabaId: WABA_ID,
      qualityRating: 'GREEN',
      token: WA_TOKEN,
    });

    const reply = await call('GET', fb(`/${WABA_ID}/phone_numbers`), { token: WA_TOKEN });

    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      data: [
        {
          id: PHONE_ID,
          display_phone_number: '+1 555 078 3881',
          verified_name: 'Acme Support',
        },
        {
          id: '222',
          display_phone_number: '+1 555 078 3882',
          verified_name: 'Second',
          quality_rating: 'GREEN',
        },
      ],
    });
  });

  it('answers a business account the token does not open, and a number’s own id, with Graph’s error', async () => {
    const elsewhere = await call('GET', fb(`/${WABA_ID}/phone_numbers`), { token: PAGE_TOKEN });
    const number = await call('GET', fb(`/${PHONE_ID}/phone_numbers`), { token: WA_TOKEN });

    expect(elsewhere.status).toBe(400);
    expect(number.status).toBe(400);
    expect(errorOf(number).code).toBe(100);
  });
});

describe('refreshing an Instagram token', () => {
  it('answers with a new token good for 60 days, and keeps the old one working', async () => {
    const reply = await call('GET', ig('/refresh_access_token'), {
      token: IG_TOKEN,
      query: { grant_type: 'ig_refresh_token' },
    });
    const renewed = reply.json.access_token as string;

    expect(reply.json).toMatchObject({ token_type: 'bearer', expires_in: 5_184_000 });
    expect(renewed).not.toBe(IG_TOKEN);
    expect(graph.knowsToken(renewed)).toBe(true);
    expect((await call('GET', ig(`/${IG_ID}`), { token: renewed })).status).toBe(200);
    expect((await call('GET', ig(`/${IG_ID}`), { token: IG_TOKEN })).status).toBe(200);

    const debug = await call('GET', ig('/debug_token'), {
      token: renewed,
      query: { input_token: renewed },
    });
    expect(debug.json).toMatchObject({
      data: { expires_at: Math.floor(NOW.getTime() / 1_000) + 5_184_000 },
    });
  });

  it('reads the token from access_token, as Instagram’s documentation writes the call', async () => {
    const reply = await call('GET', ig('/refresh_access_token'), {
      query: { grant_type: 'ig_refresh_token', access_token: IG_TOKEN },
    });

    expect(reply.status).toBe(200);
  });

  it('refuses when told to, with a permanent error rather than a dead token', async () => {
    graph.refuseRefresh = true;
    const reply = await call('GET', ig('/refresh_access_token'), { token: IG_TOKEN });

    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe(100);
  });

  it('is an Instagram call: the Facebook root has no such path', async () => {
    const reply = await call('GET', fb('/refresh_access_token'), { token: PAGE_TOKEN });

    expect(reply.status).toBe(400);
  });

  it('refuses a token that has already expired', async () => {
    graph.setTokenExpiry(IG_TOKEN, new Date(NOW.getTime() - 1_000));

    expect((await call('GET', ig('/refresh_access_token'), { token: IG_TOKEN })).status).toBe(400);
  });
});

describe('message templates', () => {
  it('lists the templates a test programmed for a business account', async () => {
    graph.templates.set(WABA_ID, [{ name: 'order_update', language: 'en', status: 'APPROVED' }]);

    expect(
      (await call('GET', fb(`/${WABA_ID}/message_templates`), { token: WA_TOKEN })).json,
    ).toEqual({
      data: [{ name: 'order_update', language: 'en', status: 'APPROVED' }],
      paging: {},
    });
    expect(
      (await call('GET', fb('/999/message_templates'), { token: WA_TOKEN })).json,
    ).toMatchObject({ data: [] });
  });
});

describe('looking back at what happened', () => {
  it('finds calls by path suffix, by pattern and by method', async () => {
    await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN });
    await call('POST', fb(`/${PHONE_ID}/messages`), { token: WA_TOKEN, body: waText(CUSTOMER) });
    await call('POST', fb(`/${PAGE_ID}/messages`), {
      token: PAGE_TOKEN,
      body: messagingText(PSID),
    });

    expect(graph.callsTo('/messages')).toHaveLength(2);
    expect(graph.callsTo('/messages', 'GET')).toHaveLength(0);
    expect(graph.callsTo(new RegExp(`^POST /${PAGE_ID}/`))).toHaveLength(1);
  });

  it('finds the messages sent to one customer, however the number is written', async () => {
    await call('POST', fb(`/${PHONE_ID}/messages`), {
      token: WA_TOKEN,
      body: waText(`+${CUSTOMER}`),
    });
    await call('POST', fb(`/${PHONE_ID}/messages`), {
      token: WA_TOKEN,
      body: waText('447700900123'),
    });

    expect(graph.sentTo(CUSTOMER)).toHaveLength(1);
    expect(graph.sentTo(`+${CUSTOMER}`)).toHaveLength(1);
    expect(graph.sentTo('447700900123')).toHaveLength(1);
  });

  it('forgets calls and programming on reset, and keeps the accounts', async () => {
    graph.windowClosed.add(CUSTOMER);
    graph.refuseRefresh = true;
    graph.failures.push({ status: 500 });
    await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN });
    graph.reset();

    expect(graph.calls).toEqual([]);
    expect(graph.windowClosed.size).toBe(0);
    expect(graph.failures).toEqual([]);
    expect(graph.refuseRefresh).toBe(false);
    expect((await call('GET', fb(`/${PHONE_ID}`), { token: WA_TOKEN })).status).toBe(200);
  });
});
