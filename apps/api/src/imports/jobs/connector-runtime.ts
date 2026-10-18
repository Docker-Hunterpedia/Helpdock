import { decryptSecret, type Keyring } from '@helpdock/config';
import { type Db, importLog } from '@helpdock/db';
import {
  type Connector,
  type ConnectorContext,
  ConnectorError,
  FreshdeskConnector,
  type FreshdeskCredentials,
  freshdeskCredentialsSchema,
  ImportHttp,
  ImportRateLimiter,
  type TicketInventory,
  ZendeskConnector,
  type ZendeskCredentials,
  ZOHO_REGIONS,
  type ZohoAccessToken,
  ZohoConnector,
  type ZohoCredentials,
  zendeskCredentialsSchema,
  zohoCredentialsSchema,
} from '@helpdock/importers';
import type { SafeFetchPolicy } from '@helpdock/net';
import {
  importDownloadHostSchema,
  importEntitySchema,
  importRequiresTicketInventory,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { ObjectStorage } from '../../media/storage.js';
import { withSystemJob } from '../../tenant/system-job.js';
import {
  ImportClaimLost,
  type ImportRunRef,
  importRunRefSchema,
  renewImportClaim,
} from './claims.js';
import { importConnectorLogSchema } from './connector-log.js';
import { extractionRun } from './extract-state.js';
import { createFileImportRuntime } from './file-runtime.js';
import { sourceAccountKey } from './source-account.js';
import { createImportTicketInventory } from './ticket-inventory.js';
import { decodedZohoCredentials, saveZohoAccessToken } from './zoho-credentials.js';

const optionsSchema = z.object({
  downloadHosts: z.array(importDownloadHostSchema).max(32).default([]),
  inventoryMode: z.enum(['archives', 'complete']).default('archives'),
  inventoryConfirmed: z.boolean().default(false),
  useTicketInventory: z.boolean().optional(),
  inventoryReviewFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  entities: z.array(importEntitySchema).optional(),
});

type Dependencies = {
  db: Db;
  keyring: Keyring;
  allowCidrs: readonly string[];
  storage?: ObjectStorage;
};
/** Overrides are test-only; production derives its API origin exclusively from validated credentials. */
type TestTransport = {
  apiRoot: string;
  accountsRoot?: string;
  policy: SafeFetchPolicy;
  limiter?: ImportRateLimiter;
};

export function createImportConnectorRuntime(deps: Dependencies, transport?: TestTransport) {
  const limiters = new Map<string, ImportRateLimiter>();
  const inventories = new Map<string, TicketInventory>();
  return async (
    raw: ImportRunRef,
  ): Promise<{ connector: Connector<unknown>; context: ConnectorContext<unknown> }> => {
    const scope = importRunRefSchema.parse(raw);
    const run = await withSystemJob(deps.db, scope.brandId, 'import.connection', (tx) =>
      extractionRun(tx, scope),
    );
    if (
      !run ||
      (run.status !== 'extracting' && run.status !== 'loading' && run.status !== 'dry_run')
    )
      throw new ConnectorError('credentials-refused');
    const phase = run.status;
    const log: ConnectorContext<unknown>['log'] = async (entry) => {
      const parsed = importConnectorLogSchema.parse(entry);
      await withSystemJob(deps.db, scope.brandId, 'import.connection', async (tx) => {
        if (!run.claimToken) throw new ImportClaimLost();
        await renewImportClaim(tx, { ...scope, token: run.claimToken, phase });
        await tx.insert(importLog).values({ ...scope, ...parsed });
      });
    };
    if (run.source === 'file') {
      if (!deps.storage) throw new ConnectorError('invalid-response');
      return createFileImportRuntime({ ...deps, storage: deps.storage }, run, log);
    }
    if (run.source !== 'zendesk' && run.source !== 'freshdesk' && run.source !== 'zohodesk')
      throw new ConnectorError('invalid-response');
    if (!run.credentialsEncrypted) throw new ConnectorError('credentials-refused');
    let decoded: unknown;
    try {
      decoded = JSON.parse(decryptSecret(run.credentialsEncrypted, deps.keyring));
    } catch {
      throw new ConnectorError('credentials-refused');
    }
    const zoho = run.source === 'zohodesk' ? decodedZohoCredentials(decoded) : null;
    const credentials =
      zoho?.credentials ??
      (run.source === 'zendesk'
        ? zendeskCredentialsSchema.parse(decoded)
        : freshdeskCredentialsSchema.parse(decoded));
    const key = sourceAccountKey({
      source: run.source,
      verifiedAccount:
        'subdomain' in credentials
          ? credentials.subdomain
          : 'domain' in credentials
            ? credentials.domain
            : `${credentials.region}:${credentials.orgId}`,
    });
    if (run.sourceAccountKey !== key) throw new ConnectorError('credentials-refused');
    const options = optionsSchema.parse(run.options);
    let limiter = limiters.get(key);
    if (!limiter) {
      // Bounded process-local budgets survive continuations without retaining credentials.
      const oldest = limiters.keys().next().value;
      if (limiters.size >= 1000 && oldest !== undefined) limiters.delete(oldest);
      limiter =
        transport?.limiter ??
        new ImportRateLimiter({ capacity: 10, perMinute: 60, resumeTokens: 10 });
      limiters.set(key, limiter);
    }
    const common = {
      downloadHosts: options.downloadHosts,
      limiter,
      allowCidrs: deps.allowCidrs,
      ...(transport ? { transport } : {}),
      log,
    };
    if ('subdomain' in credentials)
      return createZendeskImportConnection({ ...common, credentials });
    let inventory: TicketInventory | undefined;
    if (
      importRequiresTicketInventory(run.source, {
        entities: options.entities ?? [...importEntitySchema.options],
        rebuildAllReports: false,
        useTicketInventory: options.useTicketInventory ?? options.inventoryConfirmed,
      })
    ) {
      if (!options.inventoryConfirmed) throw new ConnectorError('invalid-response');
      inventory = inventories.get(run.id);
      if (!inventory || inventory.mode !== options.inventoryMode) {
        inventory = await createImportTicketInventory(deps, scope, options.inventoryMode);
        const oldest = inventories.keys().next().value;
        if (inventories.size >= 1000 && oldest !== undefined) inventories.delete(oldest);
        inventories.set(run.id, inventory);
      }
      if (inventory.fingerprint !== options.inventoryReviewFingerprint)
        throw new ConnectorError('invalid-response');
    }
    if ('region' in credentials)
      return createZohoImportConnection({
        ...common,
        credentials,
        ...(inventory ? { inventory } : {}),
        ...(zoho?.accessToken ? { initialAccessToken: zoho.accessToken } : {}),
        saveAccessToken: async (accessToken) => {
          if (!run.claimToken) throw new ImportClaimLost();
          await saveZohoAccessToken(deps, {
            claim: { ...scope, token: run.claimToken, phase },
            credentials,
            accessToken,
          });
        },
      });
    return createFreshdeskImportConnection({
      ...common,
      credentials,
      ...(inventory ? { inventory } : {}),
    });
  };
}

/** Shared transport construction for connection tests and claimed worker work. */
type ConnectionInput<C> = {
  credentials: C;
  downloadHosts: readonly string[];
  limiter: ImportRateLimiter;
  allowCidrs: readonly string[];
  log: ConnectorContext<C>['log'];
  transport?: TestTransport;
  dailyCreditLimit?: boolean;
};

function importConnectionContext<C>(
  input: ConnectionInput<C>,
  origin: URL,
  extraHosts: readonly string[] = [],
): ConnectorContext<C> {
  const hosts = optionsSchema.parse({ downloadHosts: input.downloadHosts }).downloadHosts;
  return {
    credentials: input.credentials,
    signal: new AbortController().signal,
    http: new ImportHttp({
      dailyCreditLimit: input.dailyCreditLimit ?? false,
      hosts: [...new Set([origin.hostname, ...hosts, ...extraHosts])],
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
}

export function createZendeskImportConnection(input: ConnectionInput<ZendeskCredentials>) {
  const credentials = zendeskCredentialsSchema.parse(input.credentials);
  const origin = new URL(
    input.transport?.apiRoot ?? `https://${credentials.subdomain}.zendesk.com`,
  );
  return {
    connector: new ZendeskConnector(input.transport ? { apiRoot: input.transport.apiRoot } : {}),
    context: importConnectionContext({ ...input, credentials }, origin),
  };
}

export function createFreshdeskImportConnection(
  input: ConnectionInput<FreshdeskCredentials> & { inventory?: TicketInventory },
) {
  const credentials = freshdeskCredentialsSchema.parse(input.credentials);
  const origin = new URL(input.transport?.apiRoot ?? `https://${credentials.domain}.freshdesk.com`);
  return {
    connector: new FreshdeskConnector({
      ...(input.transport ? { apiRoot: input.transport.apiRoot } : {}),
      ...(input.inventory ? { inventory: input.inventory } : {}),
    }),
    context: importConnectionContext({ ...input, credentials }, origin),
  };
}

export function createZohoImportConnection(
  input: ConnectionInput<ZohoCredentials> & {
    inventory?: TicketInventory;
    initialAccessToken?: ZohoAccessToken;
    saveAccessToken?: (token: ZohoAccessToken) => Promise<void>;
  },
) {
  const credentials = zohoCredentialsSchema.parse(input.credentials);
  const region = ZOHO_REGIONS[credentials.region];
  const origin = new URL(input.transport?.apiRoot ?? region.desk);
  const accounts = new URL(
    input.transport?.accountsRoot ?? input.transport?.apiRoot ?? region.accounts,
  );
  return {
    connector: new ZohoConnector({
      ...(input.transport ? { apiRoot: origin.href, accountsRoot: accounts.href } : {}),
      ...(input.inventory ? { inventory: input.inventory } : {}),
      ...(input.initialAccessToken ? { initialAccessToken: input.initialAccessToken } : {}),
      ...(input.saveAccessToken ? { saveAccessToken: input.saveAccessToken } : {}),
    }),
    context: importConnectionContext({ ...input, credentials, dailyCreditLimit: true }, origin, [
      accounts.hostname,
    ]),
  };
}
