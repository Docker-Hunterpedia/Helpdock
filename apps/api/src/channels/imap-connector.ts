import {
  type ImapConnectOptions,
  ImapFailure,
  type ImapSettings,
  testImapConnection,
} from '@helpdock/channels';
import { resolvePublicHost } from '@helpdock/net';
import type { ImapTestResult } from '@helpdock/schemas';
import type { ImapTester } from './mailboxes.service.js';

/**
 * How the api and the worker reach an IMAP server: through
 * `resolvePublicHost`, so a brand Admin cannot point a mailbox at the install's
 * own network (DOMAIN-RULES §13), with `OUTBOUND_ALLOW_CIDRS` as the
 * operator's escape hatch — the same one the crawler and webhooks honour.
 */
export const imapConnectOptions = (options: {
  readonly allowCidrs: readonly string[];
  readonly onBlocked?: (event: { host: string | undefined; address: string | undefined }) => void;
  /** The integration suites' self-signed server. Never set in production. */
  readonly tls?: ImapConnectOptions['tls'];
}): ImapConnectOptions => ({
  resolveHost: async (host) =>
    (
      await resolvePublicHost(host, {
        allowCidrs: [...options.allowCidrs],
        ...(options.onBlocked === undefined ? {} : { onBlocked: options.onBlocked }),
      })
    ).address,
  ...(options.tls === undefined ? {} : { tls: options.tls }),
});

export class ImapConnectionTester implements ImapTester {
  readonly #options: ImapConnectOptions;

  constructor(options: ImapConnectOptions) {
    this.#options = options;
  }

  async test(settings: ImapSettings): Promise<ImapTestResult> {
    try {
      const outcome = await testImapConnection(settings, this.#options);
      return {
        ok: true,
        host: settings.host,
        port: settings.port,
        folder: settings.folder,
        ...outcome,
      };
    } catch (error) {
      const failure =
        error instanceof ImapFailure ? error : new ImapFailure('connect', null, error);
      return {
        ok: false,
        kind: failure.kind,
        host: settings.host,
        port: settings.port,
        serverResponse: failure.serverResponse,
      };
    }
  }
}
