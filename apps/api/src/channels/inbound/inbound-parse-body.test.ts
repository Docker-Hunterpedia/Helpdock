import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  type FormBodyRoute,
  INBOUND_PARSE_ROUTE,
  registerFormBodies,
} from './inbound-parse-body.js';

const FORM_ROUTE: FormBodyRoute = { matches: (url) => url.startsWith('/form'), bodyLimit: 64 };

const multipart = async () => {
  const data = new FormData();
  data.append('field', 'value');
  const request = new Request('http://form.test', { method: 'POST', body: data });
  return {
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
    payload: Buffer.from(await request.arrayBuffer()),
  };
};

const server = async () => {
  const app = Fastify();
  registerFormBodies(app, [INBOUND_PARSE_ROUTE, FORM_ROUTE]);
  app.post('/form', async (request) => ({ bytes: (request.body as Buffer).length }));
  app.post('/internal/inbound-parse/postmark', async (request) => ({
    bytes: (request.body as Buffer).length,
  }));
  app.post('/json', async () => ({ ok: true }));
  await app.ready();
  return app;
};

describe('registerFormBodies', () => {
  it('hands a multipart body to the routes that take one, as bytes', async () => {
    const app = await server();
    const body = await multipart();

    const inbound = await app.inject({
      method: 'POST',
      url: '/internal/inbound-parse/postmark',
      ...body,
    });
    expect(inbound.statusCode).toBe(200);
    expect(inbound.json()).toEqual({ bytes: body.payload.length });
  });

  it('holds each route to its own body limit', async () => {
    const app = await server();

    const tooBig = await app.inject({ method: 'POST', url: '/form', ...(await multipart()) });
    expect(tooBig.statusCode).toBe(413);
  });

  it('refuses a multipart body everywhere else', async () => {
    const app = await server();

    const refused = await app.inject({ method: 'POST', url: '/json', ...(await multipart()) });
    expect(refused.statusCode).toBe(415);
  });
});
