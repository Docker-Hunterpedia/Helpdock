import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtureMid,
  fixtureWamid,
  instagramText,
  pageText,
  whatsappStatus,
  whatsappText,
} from '../fixtures.js';
import { hubChallenge, verifyHubSignature } from '../signature.js';
import {
  batchOf,
  httpWebhookTarget,
  MetaWebhookDriver,
  type WebhookInjectOptions,
} from './webhook-driver.js';

/**
 * The driver's own suite. A small receiver stands in for the api's route: it
 * checks the signature with the same functions the route will use, so these
 * tests prove the driver signs what the route verifies.
 */

const APP_SECRET = 'app-secret-0123456789abcdef';
const VERIFY_TOKEN = 'verify-me-0123456789';

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly raw: Buffer;
}

let server: Server;
let baseUrl = '';
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(request.url ?? '/', 'http://receiver.test');
      received.push({
        method: request.method ?? 'GET',
        url: request.url ?? '',
        headers: request.headers,
        raw,
      });

      if (request.method === 'GET') {
        const challenge = hubChallenge(Object.fromEntries(url.searchParams), VERIFY_TOKEN);
        response.statusCode = challenge === null ? 403 : 200;
        response.end(challenge ?? '');
        return;
      }
      const header = request.headers['x-hub-signature-256'];
      const verified = verifyHubSignature(raw, typeof header === 'string' ? header : undefined, [
        APP_SECRET,
      ]);
      response.statusCode = verified ? 200 : 401;
      response.end(verified ? '{"ok":true}' : '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received.length = 0;
});

const driver = (secret = APP_SECRET) =>
  new MetaWebhookDriver({ target: httpWebhookTarget(baseUrl), secret });

describe('posting a body', () => {
  it('signs it so the route accepts it, and posts it to the one webhook path as JSON', async () => {
    const response = await driver().post(whatsappText());

    expect(response).toEqual({ status: 200, body: '{"ok":true}' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'POST', url: '/api/meta/webhook' });
    expect(received[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(received[0]?.raw.toString('utf8') ?? '')).toMatchObject({
      object: 'whatsapp_business_account',
    });
  });

  it('signs the exact bytes it sends', async () => {
    const instance = driver();
    await instance.post(pageText());

    const sent = received[0];
    expect(sent?.headers['x-hub-signature-256']).toBe(
      instance.signature(sent?.raw ?? Buffer.alloc(0)),
    );
  });

  it('is refused when it signs with a wrong secret', async () => {
    const response = await driver().post(whatsappText(), { secret: 'not-the-app-secret' });

    expect(response.status).toBe(401);
  });

  it('is refused when the body is changed after it is signed', async () => {
    const response = await driver().post(whatsappText({ text: 'Original' }), {
      tamper: (raw) => Buffer.from(raw.toString('utf8').replace('Original', 'Altered!')),
    });

    expect(response.status).toBe(401);
    expect(received[0]?.raw.toString('utf8')).toContain('Altered!');
  });

  it('is refused when it sends no signature, or one that is not a signature', async () => {
    expect((await driver().post(whatsappText(), { header: null })).status).toBe(401);
    expect(received[0]?.headers['x-hub-signature-256']).toBeUndefined();

    expect((await driver().post(whatsappText(), { header: 'sha256=zzz' })).status).toBe(401);
    expect(received[1]?.headers['x-hub-signature-256']).toBe('sha256=zzz');
  });

  it('sends a header it is given verbatim, the right one included', async () => {
    const instance = driver();
    const raw = instance.raw(whatsappText());
    const response = await instance.post(whatsappText(), { header: instance.signature(raw) });

    expect(response.status).toBe(200);
  });

  it('signs with the Instagram app secret when it is built with that one', async () => {
    const response = await driver('a-different-instagram-secret').post(instagramText());

    expect(response.status).toBe(401);
  });

  it('writes the body as compact JSON, which is what Meta signs', () => {
    expect(
      driver()
        .raw({ a: 1, b: [2] })
        .toString('utf8'),
    ).toBe('{"a":1,"b":[2]}');
  });
});

describe('posting a batch', () => {
  it('joins the entries of bodies of one object in order, in a single post', async () => {
    const first = whatsappText({ phoneNumberId: '111', wamid: fixtureWamid(1) });
    const second = whatsappText({ phoneNumberId: '222', wamid: fixtureWamid(2) });
    const response = await driver().postBatch([first, second]);
    const body = JSON.parse(received[0]?.raw.toString('utf8') ?? '') as {
      entry: { changes: { value: { metadata: { phone_number_id: string } } }[] }[];
    };

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(body.entry.map((entry) => entry.changes[0]?.value.metadata.phone_number_id)).toEqual([
      '111',
      '222',
    ]);
  });

  it('refuses to mix objects in one envelope, or to batch nothing', () => {
    expect(() => batchOf(whatsappText(), pageText())).toThrow('one object');
    expect(() => batchOf()).toThrow('at least one');
  });

  it('keeps the first body’s other fields', () => {
    const batch = batchOf({ ...pageText(), custom: 'kept' }, pageText({ mid: fixtureMid(2) }));

    expect(batch).toMatchObject({ object: 'page', custom: 'kept' });
    expect(batch.entry).toHaveLength(2);
  });
});

describe('status reports', () => {
  it('builds the statuses body for a message Helpdock sent', () => {
    const body = driver().statusFor({
      wamid: fixtureWamid(9),
      status: 'read',
      timestamp: 1_791_705_700,
    });

    expect(body).toEqual(
      whatsappStatus({ wamid: fixtureWamid(9), status: 'read', timestamp: 1_791_705_700 }),
    );
    expect(JSON.stringify(body)).toContain(fixtureWamid(9));
  });

  it('posts it signed', async () => {
    const response = await driver().postStatus({ wamid: fixtureWamid(9), status: 'delivered' });

    expect(response.status).toBe(200);
    expect(JSON.stringify(JSON.parse(received[0]?.raw.toString('utf8') ?? ''))).toContain(
      '"statuses"',
    );
  });
});

describe('the handshake', () => {
  it('asks the route with subscribe, the verify token and a challenge, and gets the challenge back', async () => {
    const response = await driver().handshake({
      verifyToken: VERIFY_TOKEN,
      challenge: '1158201444',
    });

    expect(response).toEqual({ status: 200, body: '1158201444' });
    expect(received[0]).toMatchObject({ method: 'GET' });
    expect(received[0]?.url).toBe(
      `/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    );
  });

  it('is refused with a wrong token, or a mode that is not subscribe', async () => {
    expect((await driver().handshake({ verifyToken: 'wrong', challenge: '1' })).status).toBe(403);
    expect(
      (await driver().handshake({ verifyToken: VERIFY_TOKEN, challenge: '1', mode: 'unsubscribe' }))
        .status,
    ).toBe(403);
  });

  it('escapes what it puts in the query string', async () => {
    await driver().handshake({ verifyToken: 'a b&c', challenge: '1' });

    expect(received[0]?.url).toContain('hub.verify_token=a+b%26c');
  });
});

describe('a custom path and target', () => {
  it('posts to the path it is given, through any target that can inject', async () => {
    const injected: WebhookInjectOptions[] = [];
    const custom = new MetaWebhookDriver({
      target: {
        inject: async (options) => {
          injected.push(options);
          return { statusCode: 204, body: '' };
        },
      },
      secret: APP_SECRET,
      path: '/custom/path',
    });

    expect(await custom.post(whatsappText())).toEqual({ status: 204, body: '' });
    expect(injected[0]).toMatchObject({ method: 'POST', url: '/custom/path' });
    expect(Buffer.isBuffer(injected[0]?.payload)).toBe(true);
  });
});
