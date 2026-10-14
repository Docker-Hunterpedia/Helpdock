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

const hostSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((host) => {
    const url = URL.parse(`https://${host}`);
    return url !== null && url.hostname === host && !host.includes('..');
  });
const optionsSchema = z.object({ downloadHosts: z.array(hostSchema).max(32).default([]) });

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
      (run.status !== 'extracting' && run.status !== 'loading') ||
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
    const origin = new URL(transport?.apiRoot ?? `https://${credentials.subdomain}.zendesk.com`);
    let limiter = limiters.get(key);
    if (!limiter) {
      // Bounded process-local budgets survive continuations without retaining credentials.
      const oldest = limiters.keys().next().value;
      if (limiters.size >= 1000 && oldest !== undefined) limiters.delete(oldest);
      limiter = new ImportRateLimiter({ capacity: 10, perMinute: 60, resumeTokens: 10 });
      limiters.set(key, limiter);
    }
    const context: ConnectorContext<ZendeskCredentials> = {
      credentials,
      signal: new AbortController().signal,
      http: new ImportHttp({
        hosts: [origin.hostname, ...options.downloadHosts],
        limiter,
        policy: {
          allowCidrs: deps.allowCidrs,
          allowedPorts: [443],
          maxBodyBytes: 50 * 1024 * 1024,
          ...transport?.policy,
        },
      }),
      log: async (entry) => {
        const parsed = importConnectorLogSchema.parse(entry);
        await withSystemJob(deps.db, scope.brandId, 'import.connection', async (tx) => {
          if (!run.claimToken) throw new ImportClaimLost();
          await renewImportClaim(tx, { ...scope, token: run.claimToken, phase });
          await tx.insert(importLog).values({ ...scope, ...parsed });
        });
      },
    };
    return {
      connector: new ZendeskConnector(transport ? { apiRoot: transport.apiRoot } : {}),
      context,
    };
  };
}
