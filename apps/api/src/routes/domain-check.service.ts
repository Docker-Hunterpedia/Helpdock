import type { Db } from '@helpdock/db';
import { Inject, Injectable } from '@nestjs/common';
import { findHelpcenterHost } from '../domains/brand-host.js';
import type { Logger } from '../logging/logger.js';
import { DB, LOGGER } from '../runtime/tokens.js';

/** The principal id this read is recorded under, and the log line it writes. */
export const DOMAIN_CHECK_ACTION = 'domain.check';

/**
 * What Caddy is told. `issue`: a verified help center domain Caddy serves
 * TLS for. `proxied`: verified, but Cloudflare terminates TLS for it, so no
 * certificate is issued here. `refuse`: anything else.
 */
export type DomainCheckVerdict = 'issue' | 'proxied' | 'refuse';

/**
 * Answers "may this hostname get a certificate?" for Caddy's on-demand TLS
 * (ARCHITECTURE §3), from `brand_domains` as M5-07's check left it.
 *
 * The brand is unknown — that is the whole question — so the read is the
 * install-scope lookup of `domains/brand-host.ts`, uncached: a domain the
 * worker verified a moment ago must get its certificate on the handshake that
 * follows, which a cached "no" from an earlier ask would refuse.
 *
 * It is logged at `debug` and not written to `audit_log`. Caddy asks on every
 * handshake for an unknown host, so an audit row per call would be a way for a
 * stranger to fill the table (DOMAIN-RULES §11); the answer it gives away is
 * one bit about a hostname the caller already named.
 */
@Injectable()
export class DomainCheckService {
  readonly #db: Db;
  readonly #logger: Logger;

  constructor(@Inject(DB) db: Db, @Inject(LOGGER) logger: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  async verdict(domain: string): Promise<DomainCheckVerdict> {
    const host = await findHelpcenterHost(this.#db, domain, DOMAIN_CHECK_ACTION);
    const verdict: DomainCheckVerdict =
      host === undefined ? 'refuse' : host.cloudflareProxied ? 'proxied' : 'issue';

    this.#logger.debug({ domain, verdict, brandId: host?.brandId }, DOMAIN_CHECK_ACTION);
    return verdict;
  }
}
