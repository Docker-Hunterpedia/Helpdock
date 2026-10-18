import { ImportRateLimiter } from '@helpdock/importers';
import type { VendorRequestGate } from '@helpdock/importers/testing';
import {
  FakeFreshdesk,
  FakeZoho,
  freshdeskReferenceDelta,
  freshdeskReferenceFixture,
  freshdeskReferenceMedia,
  zohoCoreFixture,
  zohoReferenceDelta,
  zohoReferenceFixture,
  zohoReferenceMedia,
} from '@helpdock/importers/testing';
import {
  freshdeskCredentialsSchema,
  type ImportConnectionRequest,
  zohoCredentialsSchema,
} from '@helpdock/schemas';
import type { ImportConnectionFactory } from '../imports/imports.service.js';
import {
  createFreshdeskImportConnection,
  type createImportConnectorRuntime,
  createZohoImportConnection,
} from '../imports/jobs/connector-runtime.js';

export type NativeReferenceName = 'freshdesk' | 'zohodesk';
export type NativeReferenceSource = {
  name: NativeReferenceName;
  credentials: ImportConnectionRequest['credentials'];
  connect: ImportConnectionFactory;
  transport: NonNullable<Parameters<typeof createImportConnectorRuntime>[1]>;
  archiveIds: string[];
  firstTicketId: string;
  lastTicketId: string;
  media: Buffer;
  change(changedAt: string): void;
  failExtraction(): void;
  holdFile(): VendorRequestGate;
  calls(): readonly { method: string; path: string; authenticated: boolean }[];
  close(): Promise<void>;
};

function transport(apiRoot: string) {
  return {
    apiRoot,
    accountsRoot: apiRoot,
    policy: {
      allowedPorts: [Number(new URL(apiRoot).port)],
      allowCidrs: ['127.0.0.1/32'],
      lookup: async () => [{ address: '127.0.0.1', family: 4 as const }],
    },
    limiter: new ImportRateLimiter({ capacity: 100000, perMinute: 10000000 }),
  };
}

export async function nativeReferenceSource(
  name: NativeReferenceName,
): Promise<NativeReferenceSource> {
  if (name === 'freshdesk') {
    const fake = new FakeFreshdesk(
      {},
      {
        authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
        now: Date.now(),
      },
    );
    await fake.server.start();
    try {
      let firstFilePath = '';
      const fixture = freshdeskReferenceFixture((id) => {
        const url = fake.addAttachment(id, freshdeskReferenceMedia);
        firstFilePath ||= new URL(url).pathname;
        return url;
      });
      fake.replaceFixture(fixture);
      const wire = transport(fake.server.root);
      return {
        name,
        credentials: { domain: 'demo', apiKey: 'synthetic-key', csatApi: 'legacy' },
        connect: (request) =>
          createFreshdeskImportConnection({
            ...request,
            credentials: freshdeskCredentialsSchema.parse(request.credentials),
            transport: wire,
            limiter: wire.limiter,
            allowCidrs: [],
            log: async () => {},
          }),
        transport: wire,
        archiveIds: (fixture.tickets ?? [])
          .filter((ticket) => ticket.archived)
          .map((ticket) => String(ticket.id)),
        firstTicketId: '10000',
        lastTicketId: '10499',
        media: freshdeskReferenceMedia,
        change: (changedAt) => fake.replaceFixture(freshdeskReferenceDelta(fixture, changedAt)),
        failExtraction: () => {
          fake.server.failNext({
            path: '/api/v2/tickets',
            status: 429,
            headers: { 'Retry-After': '1' },
          });
          fake.server.failNext({ path: '/api/v2/tickets', status: 503 });
        },
        holdFile: () => {
          if (!firstFilePath) throw new Error('Missing reference attachment');
          return fake.server.holdNextRequest(firstFilePath);
        },
        calls: () => fake.server.calls,
        close: () => fake.server.close(),
      };
    } catch (error) {
      await fake.server.close();
      throw error;
    }
  }
  const fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
  try {
    let firstFilePath = '';
    const fixture = zohoReferenceFixture({
      ticket: (locator) => {
        const url = fake.addAttachment({ ...locator, kind: 'threads' }, zohoReferenceMedia);
        firstFilePath ||= new URL(url).pathname;
        return url;
      },
      article: (locator) => fake.addArticleAttachment(locator, zohoReferenceMedia),
    });
    Object.assign(fake.fixture, fixture);
    const wire = transport(fake.root);
    return {
      name,
      credentials: {
        region: 'us',
        orgId: fake.fixture.orgId,
        clientId: fake.fixture.clientId,
        clientSecret: fake.fixture.clientSecret,
        refreshToken: fake.fixture.refreshToken,
      },
      connect: (request) =>
        createZohoImportConnection({
          ...request,
          credentials: zohoCredentialsSchema.parse(request.credentials),
          transport: wire,
          limiter: wire.limiter,
          allowCidrs: [],
          log: async () => {},
        }),
      transport: wire,
      archiveIds: [],
      firstTicketId: '9007199254740000000',
      lastTicketId: '9007199254740000499',
      media: zohoReferenceMedia,
      change: (changedAt) => {
        Object.assign(fake.fixture, zohoReferenceDelta(fixture, changedAt));
      },
      failExtraction: () => {
        fake.failNext({ path: '/api/v1/tickets', status: 429, headers: { 'Retry-After': '1' } });
        fake.failNext({ path: '/api/v1/tickets', status: 503 });
      },
      holdFile: () => {
        if (!firstFilePath) throw new Error('Missing reference attachment');
        return fake.holdNextRequest(firstFilePath);
      },
      calls: () => fake.calls,
      close: () => fake.close(),
    };
  } catch (error) {
    await fake.close();
    throw error;
  }
}
