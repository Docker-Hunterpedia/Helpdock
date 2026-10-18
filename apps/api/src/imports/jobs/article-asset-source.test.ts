import { ImportRateLimiter } from '@helpdock/importers';
import { FakeZoho, VendorServer, zohoCoreFixture } from '@helpdock/importers/testing';
import { importArticleSchema } from '@helpdock/schemas';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { importArticleAssetRequests } from '../article-asset-requests.js';
import { readArticleAssetSource } from './article-asset-source.js';
import { createZohoImportConnection } from './connector-runtime.js';

const brandId = '0192a000-0000-7000-8000-000000000001';
const bytes = Buffer.from('synthetic source image bytes');
let server: VendorServer;
beforeEach(async () => {
  server = new VendorServer((url, authorization) =>
    url.pathname === '/DocsDisplay' && !authorization
      ? { status: 200, bytes, headers: { 'content-type': 'image/png' } }
      : { status: 403 },
  );
  await server.start();
});
afterEach(async () => {
  await server.close();
});

function imageSource() {
  const connection = createZohoImportConnection({
    credentials: {
      region: 'eu',
      orgId: '600000000001',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      refreshToken: 'synthetic-refresh',
    },
    downloadHosts: [],
    allowCidrs: [],
    log: async () => {},
    limiter: new ImportRateLimiter({ capacity: 10, perMinute: 1000 }),
    transport: {
      apiRoot: server.root,
      accountsRoot: server.root,
      policy: { allowedPorts: [Number(new URL(server.root).port)], allowCidrs: ['127.0.0.1/32'] },
    },
  });
  const article = importArticleSchema.parse({
    externalId: 'original',
    sectionExternalId: 'section',
    locale: 'en',
    title: 'Original',
    bodyHtml: '<img src="/DocsDisplay?zgId=source&amp;mode=inline&amp;blockId=original">',
    assetOrigin: server.root,
    draft: false,
    internal: true,
    createdAt: '2013-11-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z',
  });
  const request = importArticleAssetRequests(article, brandId, 'zohodesk')[0];
  if (!request) throw new Error('Missing synthetic image request');
  return { connection, request };
}

it('fetches resolved relative images without refreshing OAuth or attaching vendor authorization', async () => {
  const { connection, request } = imageSource();
  const source = await readArticleAssetSource(connection, request);
  const chunks: Buffer[] = [];
  for await (const chunk of source.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(source.contentType).toBe('image/png');
  expect(server.calls).toEqual([
    {
      method: 'GET',
      path: '/DocsDisplay',
      query: { zgId: 'source', mode: 'inline', blockId: 'original' },
      authenticated: false,
    },
  ]);
});

it.each([401, 403])(
  'treats unauthenticated image HTTP %s as unavailable rather than invalid vendor credentials',
  async (status) => {
    const { connection, request } = imageSource();
    server.failNext({ path: '/DocsDisplay', status });
    await expect(readArticleAssetSource(connection, request)).rejects.toMatchObject({
      code: 'record-unavailable',
      status,
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.authenticated).toBe(false);
  },
);

it.each([429, 503])('does not hide an image HTTP %s as a missing file', async (status) => {
  const { connection, request } = imageSource();
  server.failNext({ path: '/DocsDisplay', status, headers: { 'Retry-After': '2' } });
  await expect(readArticleAssetSource(connection, request)).rejects.toMatchObject(
    status === 429 ? { retryAfterMs: 2000 } : { code: 'vendor-unavailable' },
  );
});

it('does not reclassify an authenticated native-file permission refusal as an unavailable remote image', async () => {
  const fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
  try {
    const connection = createZohoImportConnection({
      credentials: {
        region: 'us',
        orgId: fake.fixture.orgId,
        clientId: fake.fixture.clientId,
        clientSecret: fake.fixture.clientSecret,
        refreshToken: fake.fixture.refreshToken,
      },
      downloadHosts: [],
      allowCidrs: [],
      log: async () => {},
      limiter: new ImportRateLimiter({ capacity: 10, perMinute: 1000 }),
      transport: {
        apiRoot: fake.root,
        accountsRoot: fake.root,
        policy: { allowedPorts: [Number(new URL(fake.root).port)], allowCidrs: ['127.0.0.1/32'] },
      },
    });
    const parent = '/api/v1/articles/7001/translations/en';
    const url = `${fake.root}${parent}/attachments/resourceOne/content`;
    const article = importArticleSchema.parse({
      externalId: 'original',
      sectionExternalId: 'section',
      locale: 'en',
      title: 'Original',
      bodyHtml: `<img src="${url}">`,
      draft: false,
      internal: true,
      createdAt: '2013-11-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
      attachments: [{ externalId: 'a:7001:en:v:1.0:r:resourceOne', fileName: 'original.png', url }],
    });
    const request = importArticleAssetRequests(article, brandId, 'zohodesk').find(
      (asset) => asset.usage === 'image',
    );
    if (!request) throw new Error('Missing native image request');
    fake.failNext({ path: `${parent}/attachments/resourceOne/content`, status: 403 });
    fake.failNext({ path: parent, status: 403 });
    await expect(readArticleAssetSource(connection, request)).rejects.toMatchObject({
      code: 'credentials-refused',
      status: 403,
    });
  } finally {
    await fake.close();
  }
});

it('refuses a relative-image redirect outside the approved download hosts before following it', async () => {
  const { connection, request } = imageSource();
  server.failNext({
    path: '/DocsDisplay',
    status: 302,
    headers: { location: 'https://unapproved.example.test/private-image.png' },
  });
  await expect(readArticleAssetSource(connection, request)).rejects.toThrow();
  expect(server.calls).toHaveLength(1);
  expect(server.calls[0]?.authenticated).toBe(false);
});
