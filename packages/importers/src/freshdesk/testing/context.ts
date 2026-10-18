import type { ConnectorContext } from '../../connector.js';
import { ImportHttp } from '../../http.js';
import { ImportRateLimiter } from '../../rate-limiter.js';
import type { FreshdeskCredentials } from '../contracts.js';
import type { FakeFreshdesk } from './fake-freshdesk.js';

/** Test-only loopback transport; an unexpected vendor/CDN destination cannot reach the internet. */
export function freshdeskTestContext(
  fake: FakeFreshdesk,
  log: ConnectorContext<FreshdeskCredentials>['log'] = async () => {},
  limiter = new ImportRateLimiter({ capacity: 100, perMinute: 1000 }),
): ConnectorContext<FreshdeskCredentials> {
  return {
    credentials: { domain: 'demo', apiKey: 'synthetic-key' },
    signal: new AbortController().signal,
    log,
    http: new ImportHttp({
      hosts: ['127.0.0.1'],
      limiter,
      policy: {
        allowedPorts: [Number(new URL(fake.server.root).port)],
        allowCidrs: ['127.0.0.1/32'],
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      },
    }),
  };
}
