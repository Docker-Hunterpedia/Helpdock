import { decryptSecret, type Keyring } from '@helpdock/config';
import { type Db, importLog } from '@helpdock/db';
import {
  type ConnectorContext,
  ConnectorError,
  ImportHttp,
  ImportRateLimiter,
  ZendeskConnector,
  type ZendeskCredentials,
  zendeskCredentialsSchema,
} from '@helpdock/importers';
import type { SafeFetchPolicy } from '@helpdock/net';
import { importDownloadHostSchema } from '@helpdock/schemas';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import {
  ImportClaimLost,
  type ImportRunRef,
  importRunRefSchema,
  renewImportClaim,
} from './claims.js';
import { importConnectorLogSchema } from './connector-log.js';
import { extractionRun } from './extract-state.js';
import { sourceAccountKey } from './source-account.js';

const optionsSchema = z.object({
  downloadHosts: z.array(importDownloadHostSchema).max(32).default([]),
});

type Dependencies = { db: Db; keyring: Keyring; allowCidrs: readonly string[] };
/** Overrides are test-only; production derives its API origin exclusively from validated credentials. */
type TestTransport = { apiRoot: string; policy: SafeFetchPolicy };

export function createImportConnectorRuntime(deps: Dependencies, transport?: TestTransport) {
  const limiters = new Map<string, ImportRateLimiter>();
  return async (raw: ImportRunRef) => {
    const scope = importRunRefSchema.parse(raw);
    const run = await withSystemJob(deps.db, scope.brandId, 'import.connection', (tx) =>
      extractionRun(tx, scope),
    );
    if (
      !run ||
      (run.status !== 'extracting' && run.status !== 'loading' && run.status !== 'dry_run') ||
      !run.credentialsEncrypted
    )
      throw new ConnectorError('credentials-refused');
    const phase = run.status;
    if (run.source !== 'zendesk') throw new ConnectorError('invalid-response');
    let decoded: unknown;
    try {
      decoded = JSON.parse(decryptSecret(run.credentialsEncrypted, deps.keyring));
    } catch {
      throw new ConnectorError('credentials-refused');
    }
    const credentials = zendeskCredentialsSchema.parse(decoded);
    const key = sourceAccountKey({ source: run.source, verifiedAccount: credentials.subdomain });
    if (run.sourceAccountKey !== key) throw new ConnectorError('credentials-refused');
    const options = optionsSchema.parse(run.options);
    let limiter = limiters.get(key);
    if (!limiter) {
      // Bounded process-local budgets survive continuations without retaining credentials.
      const oldest = limiters.keys().next().value;
      if (limiters.size >= 1000 && oldest !== undefined) limiters.delete(oldest);
      limiter = new ImportRateLimiter({ capacity: 10, perMinute: 60, resumeTokens: 10 });
      limiters.set(key, limiter);
    }
    return createZendeskImportConnection({
      credentials,
      downloadHosts: options.downloadHosts,
      limiter,
      allowCidrs: deps.allowCidrs,
      ...(transport ? { transport } : {}),
      log: async (entry) => {
        const parsed = importConnectorLogSchema.parse(entry);
        await withSystemJob(deps.db, scope.brandId, 'import.connection', async (tx) => {
          if (!run.claimToken) throw new ImportClaimLost();
          await renewImportClaim(tx, { ...scope, token: run.claimToken, phase });
          await tx.insert(importLog).values({ ...scope, ...parsed });
        });
      },
    });
  };
}

/** Shared transport construction for connection tests and claimed worker work. */
export function createZendeskImportConnection(input: {
  credentials: ZendeskCredentials;
  downloadHosts: readonly string[];
  limiter: ImportRateLimiter;
  allowCidrs: readonly string[];
  log: ConnectorContext<ZendeskCredentials>['log'];
  transport?: TestTransport;
}) {
  const credentials = zendeskCredentialsSchema.parse(input.credentials);
  const hosts = optionsSchema.parse({ downloadHosts: input.downloadHosts }).downloadHosts;
  const origin = new URL(
    input.transport?.apiRoot ?? `https://${credentials.subdomain}.zendesk.com`,
  );
  const context: ConnectorContext<ZendeskCredentials> = {
    credentials,
    signal: new AbortController().signal,
    http: new ImportHttp({
      hosts: [origin.hostname, ...hosts],
      limiter: input.limiter,
      policy: {
        allowCidrs: input.allowCidrs,
        allowedPorts: [443],
        maxBodyBytes: 50 * 1024 * 1024,
        ...input.transport?.policy,
      },
    }),
    log: input.log,
  };
  return {
    connector: new ZendeskConnector(input.transport ? { apiRoot: input.transport.apiRoot } : {}),
    context,
  };
}
