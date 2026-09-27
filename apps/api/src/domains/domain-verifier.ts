import { auditLog, type BrandDomain, type Db, type DbTransaction } from '@helpdock/db';
import type { JobLogger } from '@helpdock/jobs';
import type { DnsResolver, TlsProbeResult } from '@helpdock/net';
import { txtRecordNameFor } from '@helpdock/schemas';
import { withSystemJob } from '../tenant/system-job.js';
import {
  applyTls,
  type CheckTransition,
  type DnsObservation,
  decideCheck,
  evaluateDns,
  isCheckDue,
} from './domain-rules.js';
import type { DomainsRepository } from './domains.repository.js';

/**
 * The worker's half of M5-07: one check of one custom help center domain.
 *
 * ```
 * read the row            (system transaction of the brand)
 * ask DNS                 (no transaction: a slow name server holds no connection)
 * write what DNS said     (system transaction; audit on verified / lost; primary if none)
 * TLS handshake           (no transaction; only once verified, not behind Cloudflare)
 * write what TLS said     (system transaction)
 * ```
 *
 * The verification is committed **before** the handshake on purpose: the
 * handshake is what makes Caddy ask `/internal/domain-check`, and the api can
 * only say yes to a domain whose `verified_at` it can read.
 *
 * Every lookup goes through `@helpdock/net`: the DNS reader with its deadlines,
 * and the TLS probe, which resolves the name through the SSRF-safe resolver and
 * connects only to a public address (DOMAIN-RULES §13).
 */

export interface DomainProbes {
  readonly dns: DnsResolver;
  readonly tls: (hostname: string) => Promise<TlsProbeResult>;
}

export interface DomainVerifierOptions {
  readonly db: Db;
  readonly repository: DomainsRepository;
  readonly probes: DomainProbes;
  readonly cnameTarget: string;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

export type CheckOutcome = 'missing' | 'inconclusive' | 'pending' | 'verified' | 'failed';

export class DomainVerifier {
  readonly #db: Db;
  readonly #repository: DomainsRepository;
  readonly #probes: DomainProbes;
  readonly #cnameTarget: string;
  readonly #log: JobLogger;
  readonly #now: () => Date;

  constructor(options: DomainVerifierOptions) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#probes = options.probes;
    this.#cnameTarget = options.cnameTarget;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  /** Every domain of the brand whose re-check is due. Returns how many were checked. */
  async checkDue(brandId: string, jobId: string): Promise<number> {
    const now = this.#now();
    const due = (
      await withSystemJob(this.#db, brandId, jobId, (tx) => this.#repository.list(tx))
    ).filter((row) => isCheckDue(row, now));

    for (const row of due) {
      await this.checkOne(brandId, row.id, jobId);
    }
    return due.length;
  }

  async checkOne(brandId: string, domainId: string, jobId: string): Promise<CheckOutcome> {
    const inBrand = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
      withSystemJob(this.#db, brandId, jobId, fn);

    const row = await inBrand((tx) => this.#repository.find(tx, domainId));
    if (row === undefined) {
      // Removed since the check was asked for.
      return 'missing';
    }

    const verdict = evaluateDns(await this.#observe(row.domain), {
      token: row.txtToken,
      cnameTarget: this.#cnameTarget,
    });
    const decision = decideCheck(row, verdict, this.#now());

    const written = await inBrand(async (tx) => {
      const current = await this.#repository.lock(tx, domainId);
      // Removed, or its Cloudflare flag changed while DNS was being read: the
      // reading belongs to a row that no longer exists, and the change queued
      // a check of its own.
      if (current === undefined || current.cloudflareProxied !== row.cloudflareProxied) {
        return undefined;
      }
      const updated = await this.#repository.update(tx, domainId, decision.update);
      await this.#record(tx, { brandId, jobId, row: current, transition: decision.transition });
      return updated;
    });
    if (written === undefined) {
      return 'missing';
    }

    const final = decision.probeTls ? await this.#probeTls(inBrand, written) : written;
    const outcome = verdict.inconclusive ? 'inconclusive' : outcomeOf(final);
    this.#log.info(
      {
        domainId,
        brandId,
        outcome,
        transition: decision.transition,
        failure: final.failureReason,
      },
      'domain checked',
    );
    return outcome;
  }

  async #observe(domain: string): Promise<DnsObservation> {
    const [cname, txt, addresses, targetAddresses] = await Promise.all([
      this.#probes.dns.cname(domain),
      this.#probes.dns.txt(txtRecordNameFor(domain)),
      this.#probes.dns.addresses(domain),
      this.#probes.dns.addresses(this.#cnameTarget),
    ]);
    return { cname, txt, addresses, targetAddresses };
  }

  async #probeTls(
    inBrand: <T>(fn: (tx: DbTransaction) => Promise<T>) => Promise<T>,
    written: BrandDomain,
  ): Promise<BrandDomain> {
    const result = await this.#probes.tls(written.domain);
    const update = applyTls(written, result, this.#now());

    return (
      (await inBrand(async (tx) => {
        const current = await this.#repository.lock(tx, written.id);
        // Only onto the row the handshake was for: still verified, still not proxied.
        if (current === undefined || current.verifiedAt === null || current.cloudflareProxied) {
          return current;
        }
        return this.#repository.update(tx, written.id, {
          tlsIssuedAt: update.tlsIssuedAt,
          failureReason: update.failureReason,
          failureDetail: update.failureDetail,
        });
      })) ?? written
    );
  }

  /**
   * An audit row for a verification won or lost, as the job (a `system` actor
   * named by its job id); and the first verified domain of a brand becomes its
   * primary one, so the help center always has a canonical host once it has any.
   */
  async #record(
    tx: DbTransaction,
    {
      brandId,
      jobId,
      row,
      transition,
    }: {
      readonly brandId: string;
      readonly jobId: string;
      readonly row: BrandDomain;
      readonly transition: CheckTransition;
    },
  ): Promise<void> {
    if (transition === null) {
      return;
    }
    if (transition === 'verified' && !(await this.#repository.hasVerifiedPrimary(tx, brandId))) {
      await this.#repository.makePrimary(tx, brandId, row.id);
    }
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'system',
      actorId: jobId,
      action: transition === 'verified' ? 'domain.verified' : 'domain.verification_lost',
      targetType: 'brand_domain',
      targetId: row.id,
      meta: { domain: row.domain },
    });
  }
}

const outcomeOf = (row: BrandDomain): CheckOutcome => {
  if (row.failureReason !== null) {
    return 'failed';
  }
  return row.verifiedAt === null ? 'pending' : 'verified';
};
