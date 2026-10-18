import type { ConnectorContext } from '../../connector.js';
import { ImportHttp } from '../../http.js';
import { ImportRateLimiter } from '../../rate-limiter.js';
import { ZohoDeskClient } from '../client.js';
import { type ZohoAccessToken, ZohoOAuthSession } from '../oauth.js';
import type { ZohoCredentials } from '../regions.js';
import type { FakeZoho } from './fake-zoho.js';

/** Loopback-only transport: malformed locators cannot reach a real vendor or asset host. */
export function zohoTestConnection(
  fake: FakeZoho,
  options: {
    credentials?: ZohoCredentials;
    now?: () => number;
    log?: ConnectorContext<ZohoCredentials>['log'];
    initialAccessToken?: ZohoAccessToken;
    saveAccessToken?: (token: ZohoAccessToken) => Promise<void>;
  } = {},
) {
  const credentials = options.credentials ?? {
    region: 'us',
    orgId: fake.fixture.orgId,
    clientId: fake.fixture.clientId,
    clientSecret: fake.fixture.clientSecret,
    refreshToken: fake.fixture.refreshToken,
  };
  const context: ConnectorContext<ZohoCredentials> = {
    credentials,
    signal: new AbortController().signal,
    log: options.log ?? (async () => {}),
    http: new ImportHttp({
      dailyCreditLimit: true,
      hosts: ['127.0.0.1'],
      limiter: new ImportRateLimiter({
        capacity: 10000,
        perMinute: 100000,
        ...(options.now ? { now: options.now } : {}),
      }),
      policy: {
        allowedPorts: [Number(new URL(fake.root).port)],
        allowCidrs: ['127.0.0.1/32'],
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      },
    }),
  };
  const oauth = new ZohoOAuthSession(credentials, context.http, {
    signal: context.signal,
    accountsRoot: fake.root,
    ...(options.now ? { now: options.now } : {}),
    ...(options.initialAccessToken ? { initialAccessToken: options.initialAccessToken } : {}),
    ...(options.saveAccessToken ? { saveAccessToken: options.saveAccessToken } : {}),
  });
  return { context, oauth, client: new ZohoDeskClient(context, oauth, fake.root) };
}
