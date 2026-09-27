import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerWidgetCors, widgetCorsHeaders } from './widget-cors.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

const app = async () => {
  const fastify = Fastify();
  registerWidgetCors(fastify);
  fastify.get('/api/widget/:brandId/config', async () => ({ ok: true }));
  fastify.get('/api/me', async () => ({ ok: true }));
  await fastify.ready();
  return fastify;
};

describe('widget CORS', () => {
  it('answers a preflight on a widget route with the headers the widget sends', async () => {
    const response = await (await app()).inject({
      method: 'OPTIONS',
      url: `/api/widget/${BRAND}/session`,
      headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'POST' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': 'https://shop.example.com',
      'access-control-allow-headers': 'authorization, content-type, if-none-match',
      'cross-origin-resource-policy': 'cross-origin',
    });
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('echoes the origin on a widget response and leaves every other route alone', async () => {
    const fastify = await app();
    const widget = await fastify.inject({
      method: 'GET',
      url: `/api/widget/${BRAND}/config`,
      headers: { origin: 'https://shop.example.com' },
    });
    const other = await fastify.inject({
      method: 'GET',
      url: '/api/me',
      headers: { origin: 'https://shop.example.com' },
    });

    expect(widget.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends no allow-origin without an origin', () => {
    expect(widgetCorsHeaders(undefined)).toEqual({
      'cross-origin-resource-policy': 'cross-origin',
    });
  });
});
