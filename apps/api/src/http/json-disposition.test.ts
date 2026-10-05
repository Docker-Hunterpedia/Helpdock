import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { API_JSON_DISPOSITION, registerJsonDisposition } from './json-disposition.js';

const apps: ReturnType<typeof Fastify>[] = [];

const appWith = async () => {
  const app = Fastify();
  apps.push(app);
  registerJsonDisposition(app);
  app.get('/json', async () => ({ ok: true }));
  app.get('/problem', async (_request, reply) =>
    reply.type('application/problem+json').send('{"error":1}'),
  );
  app.get('/html', async (_request, reply) => reply.type('text/html').send('<p>hi</p>'));
  app.get('/file', async (_request, reply) =>
    reply.header('content-disposition', 'attachment; filename="export.json"').send({ a: 1 }),
  );
  await app.ready();
  return app;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('registerJsonDisposition (ASVS 14.4.2)', () => {
  it('marks a JSON answer, and a +json one, as a download', async () => {
    const app = await appWith();

    expect((await app.inject('/json')).headers['content-disposition']).toBe(API_JSON_DISPOSITION);
    expect((await app.inject('/problem')).headers['content-disposition']).toBe(
      API_JSON_DISPOSITION,
    );
  });

  it('leaves a page alone, and keeps a disposition a route chose itself', async () => {
    const app = await appWith();

    expect((await app.inject('/html')).headers['content-disposition']).toBeUndefined();
    expect((await app.inject('/file')).headers['content-disposition']).toBe(
      'attachment; filename="export.json"',
    );
  });
});
