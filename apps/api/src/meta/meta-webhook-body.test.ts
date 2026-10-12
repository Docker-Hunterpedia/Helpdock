import { hubSignature, matchHubSignature } from '@helpdock/channels';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  META_WEBHOOK_BODY_LIMIT,
  type MetaWebhookGate,
  type MetaWebhookRequest,
  registerMetaWebhookBody,
} from './meta-webhook-body.js';

/**
 * The webhook's body handling against a bare Fastify instance, the way
 * `inbound-parse-body.test.ts` tests the form routes: no Nest, no database.
 */

const WEBHOOK = '/api/meta/webhook';
const OTHER = '/api/other';
const SECRET = 'app-secret';

const gateOf = (overrides: Partial<MetaWebhookGate> = {}): MetaWebhookGate => ({
  admit: () => true,
  authenticate: async (raw, signature) =>
    matchHubSignature(raw, signature, [SECRET]) === undefined ? undefined : 'app',
  ...overrides,
});

const build = async (gate: MetaWebhookGate | null = gateOf()) => {
  const adapter = new FastifyAdapter();
  registerMetaWebhookBody(adapter, gate ?? undefined);
  const fastify = adapter.getInstance();
  for (const path of [WEBHOOK, OTHER]) {
    fastify.post(path, async (request) => ({
      body: request.body,
      signer: (request as MetaWebhookRequest).metaSigner ?? null,
    }));
  }
  await fastify.ready();
  return fastify;
};

const post = (
  fastify: Awaited<ReturnType<typeof build>>,
  url: string,
  payload: string | Buffer,
  {
    contentType = 'application/json',
    signature,
  }: { contentType?: string; signature?: string } = {},
) =>
  fastify.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': contentType,
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
    payload,
  });

/** A POST to the webhook signed as Meta signs it. */
const signedPost = (fastify: Awaited<ReturnType<typeof build>>, bytes: string, url = WEBHOOK) =>
  post(fastify, url, bytes, { signature: hubSignature(Buffer.from(bytes), SECRET) });

let current: Awaited<ReturnType<typeof build>> | undefined;
const app = async (gate?: MetaWebhookGate | null) => {
  current = await build(gate);
  return current;
};

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('registerMetaWebhookBody', () => {
  describe('the signature', () => {
    it('is checked over the exact bytes, spacing and key order included, and who signed is kept', async () => {
      const fastify = await app();
      // Re-serialising this would not reproduce the bytes that were signed.
      const bytes = '{ "object" : "page",\n "entry":[ ] , "a":1.0 }';

      const response = await signedPost(fastify, bytes);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ body: { object: 'page', entry: [], a: 1 }, signer: 'app' });
    });

    it('is checked with the bytes and the header the request carried', async () => {
      const authenticate = vi.fn(async () => 'app' as const);
      const fastify = await app(gateOf({ authenticate }));

      await post(fastify, WEBHOOK, '{"a":1}', { signature: 'sha256=abc' });

      expect(authenticate).toHaveBeenCalledWith(Buffer.from('{"a":1}'), 'sha256=abc');
    });

    it('is checked when the request carries a query string', async () => {
      const fastify = await app();
      const bytes = '{"a":1}';

      const response = await signedPost(fastify, bytes, `${WEBHOOK}?x=1`);

      expect(response.json()).toMatchObject({ body: { a: 1 }, signer: 'app' });
    });

    it('is refused with a 401 for a body signed with another secret', async () => {
      const fastify = await app();

      const response = await post(fastify, WEBHOOK, '{"a":1}', {
        signature: hubSignature(Buffer.from('{"a":1}'), 'someone-elses'),
      });

      expect(response.statusCode).toBe(401);
    });

    it('is refused with a 401 for a body that is missing its signature', async () => {
      const fastify = await app();

      expect((await post(fastify, WEBHOOK, '{"a":1}')).statusCode).toBe(401);
    });

    it('costs no parse: a body that is not JSON and not signed is a 401, not a 400', async () => {
      const fastify = await app();

      expect((await post(fastify, WEBHOOK, '{not json')).statusCode).toBe(401);
    });

    it('costs no parse for a 3 MiB body that is JSON to its last byte and not signed', async () => {
      const parse = vi.spyOn(JSON, 'parse');
      const fastify = await app();
      const big = JSON.stringify({ filler: 'x'.repeat(2 * 1024 * 1024) });
      parse.mockClear();

      const response = await post(fastify, WEBHOOK, big);

      expect(response.statusCode).toBe(401);
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
    });

    it('is refused for a signature header sent twice', async () => {
      const fastify = await app();
      const bytes = '{"a":1}';
      const good = hubSignature(Buffer.from(bytes), SECRET);

      const response = await fastify.inject({
        method: 'POST',
        url: WEBHOOK,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': [good, good] },
        payload: bytes,
      });

      // Node joins a repeated header the way a proxy would; either way the digest is not one.
      expect(response.statusCode).toBe(401);
    });
  });

  describe('the address’s budget', () => {
    it('is charged before the signature or the JSON is looked at, and a refusal is a 429', async () => {
      const authenticate = vi.fn(async () => 'app' as const);
      const parse = vi.spyOn(JSON, 'parse');
      const fastify = await app(gateOf({ admit: () => false, authenticate }));
      parse.mockClear();

      const response = await signedPost(fastify, '{"a":1}');

      expect(response.statusCode).toBe(429);
      expect(authenticate).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
    });

    it('is charged to the address the request came from', async () => {
      const admit = vi.fn(() => true);
      const fastify = await app(gateOf({ admit }));

      await signedPost(fastify, '{"a":1}');

      expect(admit).toHaveBeenCalledWith('127.0.0.1');
    });
  });

  describe('everything else about the body', () => {
    it('answers who signed on the webhook and nothing on any other route', async () => {
      const fastify = await app();

      const response = await post(fastify, OTHER, '{"a":1}');

      expect(response.json()).toEqual({ body: { a: 1 }, signer: null });
    });

    it('takes a signed body up to Meta’s 3 MiB here and Fastify’s 1 MiB everywhere else', async () => {
      const fastify = await app();
      const big = JSON.stringify({ filler: 'x'.repeat(2 * 1024 * 1024) });

      expect((await signedPost(fastify, big)).statusCode).toBe(200);
      expect((await post(fastify, OTHER, big)).statusCode).toBe(413);
    });

    it('refuses a webhook body past 3 MiB', async () => {
      const fastify = await app();
      const tooBig = JSON.stringify({ filler: 'x'.repeat(META_WEBHOOK_BODY_LIMIT) });

      expect((await signedPost(fastify, tooBig)).statusCode).toBe(413);
    });

    it('still refuses a signed prototype-poisoning body, on the webhook and on every other route', async () => {
      const fastify = await app();
      const poisoned = '{"object":"page","__proto__":{"admin":true}}';

      expect((await signedPost(fastify, poisoned)).statusCode).toBe(400);
      expect((await post(fastify, OTHER, poisoned)).statusCode).toBe(400);
    });

    it('answers a signed body that is not JSON with a 400, not a crash', async () => {
      const fastify = await app();

      expect((await signedPost(fastify, '{not json')).statusCode).toBe(400);
    });

    it('leaves url-encoded forms to the parser Nest registers', async () => {
      const fastify = await app();

      const response = await post(fastify, OTHER, 'a=1&b=two', {
        contentType: 'application/x-www-form-urlencoded',
      });

      expect(response.json()).toEqual({ body: { a: '1', b: 'two' }, signer: null });
    });

    it('parses the webhook path like any other when the install has no Meta gate', async () => {
      const fastify = await app(null);

      const response = await post(fastify, WEBHOOK, '{"a":1}');

      expect(response.json()).toEqual({ body: { a: 1 }, signer: null });
    });
  });
});
