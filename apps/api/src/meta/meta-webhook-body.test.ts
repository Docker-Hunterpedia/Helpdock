import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { META_WEBHOOK_BODY_LIMIT, registerMetaWebhookBody } from './meta-webhook-body.js';

/**
 * The webhook's body handling against a bare Fastify instance, the way
 * `inbound-parse-body.test.ts` tests the form routes: no Nest, no database.
 */

const WEBHOOK = '/api/meta/webhook';
const OTHER = '/api/other';

const build = async () => {
  const adapter = new FastifyAdapter();
  registerMetaWebhookBody(adapter);
  const fastify = adapter.getInstance();
  for (const path of [WEBHOOK, OTHER]) {
    fastify.post(path, async (request) => ({
      body: request.body,
      raw: (request as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? null,
    }));
  }
  await fastify.ready();
  return fastify;
};

const post = (
  fastify: Awaited<ReturnType<typeof build>>,
  url: string,
  payload: string | Buffer,
  contentType = 'application/json',
) =>
  fastify.inject({
    method: 'POST',
    url,
    headers: { 'content-type': contentType },
    payload,
  });

let current: Awaited<ReturnType<typeof build>> | undefined;
const app = async () => {
  current = await build();
  return current;
};

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('registerMetaWebhookBody', () => {
  it('keeps the exact bytes of the webhook body, spacing and key order included', async () => {
    const fastify = await app();
    const bytes = '{ "object" : "page",\n "entry":[ ] , "a":1.0 }';

    const response = await post(fastify, WEBHOOK, bytes);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: { object: 'page', entry: [], a: 1 }, raw: bytes });
  });

  it('keeps the bytes when the request carries a query string', async () => {
    const fastify = await app();

    const response = await post(fastify, `${WEBHOOK}?x=1`, '{"a":1}');

    expect(response.json()).toMatchObject({ raw: '{"a":1}' });
  });

  it('keeps nothing on any other route', async () => {
    const fastify = await app();

    const response = await post(fastify, OTHER, '{"a":1}');

    expect(response.json()).toEqual({ body: { a: 1 }, raw: null });
  });

  it('takes a body up to Meta’s 3 MiB here and Fastify’s 1 MiB everywhere else', async () => {
    const fastify = await app();
    const big = JSON.stringify({ filler: 'x'.repeat(2 * 1024 * 1024) });

    expect((await post(fastify, WEBHOOK, big)).statusCode).toBe(200);
    expect((await post(fastify, OTHER, big)).statusCode).toBe(413);
  });

  it('refuses a webhook body past 3 MiB', async () => {
    const fastify = await app();
    const tooBig = JSON.stringify({ filler: 'x'.repeat(META_WEBHOOK_BODY_LIMIT) });

    expect((await post(fastify, WEBHOOK, tooBig)).statusCode).toBe(413);
  });

  it('still refuses a prototype-poisoning body, on the webhook and on every other route', async () => {
    const fastify = await app();
    const poisoned = '{"object":"page","__proto__":{"admin":true}}';

    expect((await post(fastify, WEBHOOK, poisoned)).statusCode).toBe(400);
    expect((await post(fastify, OTHER, poisoned)).statusCode).toBe(400);
  });

  it('answers a body that is not JSON with a 400, not a crash', async () => {
    const fastify = await app();

    expect((await post(fastify, WEBHOOK, '{not json')).statusCode).toBe(400);
  });

  it('leaves url-encoded forms to the parser Nest registers', async () => {
    const fastify = await app();

    const response = await post(fastify, OTHER, 'a=1&b=two', 'application/x-www-form-urlencoded');

    expect(response.json()).toEqual({ body: { a: '1', b: 'two' }, raw: null });
  });
});
