import { randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { auditLog, type BrandDomain, type DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { parsePublicHostname } from '@helpdock/net';
import {
  type CustomDomain,
  type CustomDomainCreateRequest,
  type CustomDomainList,
  type CustomDomainUpdateRequest,
  MAX_HELPCENTER_DOMAINS,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { mayRequestCheck } from './domain-rules.js';
import { toCustomDomain } from './domain-view.js';
import type { DomainsRepository } from './domains.repository.js';
import { DomainsFailure } from './domains-failure.js';

/**
 * Brand › Domains (M5-07): add a help center domain, show the records to
 * publish, ask for a check, flag it as proxied by Cloudflare, make it primary,
 * remove it.
 *
 * The rules it keeps:
 *
 * - **A typed hostname is hostile.** It is converted to punycode and must be a
 *   name that can be public (`@helpdock/net`'s `parsePublicHostname`); the
 *   install's own hosts are refused outright, because routing one of them to a
 *   brand would hand that brand the admin.
 * - **Nothing here touches DNS.** Every check is a `domain.verify` job, asked
 *   for through the outbox in the same transaction (DOMAIN-RULES §6).
 * - **Every change is audited**, with the hostname and what changed.
 */

export const DOMAIN_CHECK_REQUESTED_EVENT = 'domain.check_requested';

export type DomainsAuditAction = 'domain.added' | 'domain.updated' | 'domain.removed';

/** Any script's letters and marks, digits, hyphens and dots: what a hostname is typed with. */
const HOSTNAME_CHARACTERS = /^[\p{L}\p{M}\p{N}.-]+$/u;

/** 16 random bytes as hex: unguessable, and only letters and digits, which every DNS host accepts in a TXT value. */
const newTxtToken = (): string => randomBytes(16).toString('hex');

export interface DomainsServiceOptions {
  readonly repository: DomainsRepository;
  /** Where every CNAME points (`HELPCENTER_CNAME_TARGET`, or the host of `APP_URL`). */
  readonly cnameTarget: string;
  /** Hosts no brand may claim: the install's own. */
  readonly reservedHosts: readonly string[];
  readonly now?: () => Date;
}

export class DomainsService {
  readonly #repository: DomainsRepository;
  readonly #cnameTarget: string;
  readonly #reserved: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(options: DomainsServiceOptions) {
    this.#repository = options.repository;
    this.#cnameTarget = options.cnameTarget;
    this.#reserved = new Set([options.cnameTarget, ...options.reservedHosts]);
    this.#now = options.now ?? (() => new Date());
  }

  async list(tx: DbTransaction): Promise<CustomDomainList> {
    const rows = await this.#repository.list(tx);
    return { cnameTarget: this.#cnameTarget, domains: rows.map((row) => this.#view(row)) };
  }

  async add(context: TicketingContext, request: CustomDomainCreateRequest): Promise<CustomDomain> {
    const { tx, brandId } = context;
    const domain = this.#hostnameOf(request.domain);

    if ((await this.#repository.countForBrand(tx, brandId)) >= MAX_HELPCENTER_DOMAINS) {
      throw new DomainsFailure('domain-limit');
    }

    const now = this.#now();
    const row = await this.#repository.insert(tx, {
      brandId,
      domain,
      txtToken: newTxtToken(),
      checkRequestedAt: now,
    });
    if (row === undefined) {
      throw new DomainsFailure('domain-taken');
    }

    await this.#requestCheck(context, row.id);
    await this.#audit(context, 'domain.added', row.id, { domain });

    return this.#view(row);
  }

  /** "Check now". A second press within the cooldown is answered without queueing another check. */
  async check(context: TicketingContext, id: string): Promise<CustomDomain> {
    const row = await this.#require(context.tx, id);
    if (!mayRequestCheck(row, this.#now())) {
      return this.#view(row);
    }

    const updated = await this.#repository.update(context.tx, id, {
      checkRequestedAt: this.#now(),
    });
    await this.#requestCheck(context, id);
    return this.#view(updated ?? row);
  }

  async update(
    context: TicketingContext,
    id: string,
    request: CustomDomainUpdateRequest,
  ): Promise<CustomDomain> {
    const { tx, brandId } = context;
    const row = await this.#require(tx, id);
    const changes: Record<string, unknown> = {};

    if (request.primary === true && !row.isPrimary) {
      if (row.verifiedAt === null) {
        throw new DomainsFailure('domain-not-verified');
      }
      await this.#repository.makePrimary(tx, brandId, id);
      changes.primary = true;
    }

    if (
      request.cloudflareProxied !== undefined &&
      request.cloudflareProxied !== row.cloudflareProxied
    ) {
      // A failure recorded under the old setting may not hold under the new
      // one, and the check that says so is queued in this same transaction.
      await this.#repository.update(tx, id, {
        cloudflareProxied: request.cloudflareProxied,
        failureReason: null,
        failureDetail: null,
        checkRequestedAt: this.#now(),
      });
      await this.#requestCheck(context, id);
      changes.cloudflareProxied = request.cloudflareProxied;
    }

    if (Object.keys(changes).length > 0) {
      await this.#audit(context, 'domain.updated', id, { domain: row.domain, ...changes });
    }

    return this.#view(await this.#require(tx, id));
  }

  /**
   * Removes the domain. When it was the primary, the oldest other verified
   * domain takes over, so the help center's links never name a host that no
   * longer routes here.
   */
  async remove(context: TicketingContext, id: string): Promise<void> {
    const { tx, brandId } = context;
    const removed = await this.#repository.delete(tx, id);
    if (removed === undefined) {
      throw new NotFoundException('No such domain');
    }

    if (removed.isPrimary) {
      const successor = (await this.#repository.list(tx)).find((row) => row.verifiedAt !== null);
      if (successor !== undefined) {
        await this.#repository.makePrimary(tx, brandId, successor.id);
      }
    }

    await this.#audit(context, 'domain.removed', id, { domain: removed.domain });
  }

  // ------------------------------------------------------------------

  /** Punycode first, so an Arabic or other Unicode name is judged by the name DNS will see. */
  #hostnameOf(input: string): string {
    const typed = input.trim().toLowerCase().replace(/\.$/, '');
    // `domainToASCII` is a URL host parser: it would quietly drop a path or a
    // port, so anything but letters, digits, hyphens and dots is refused first.
    if (!HOSTNAME_CHARACTERS.test(typed)) {
      throw new DomainsFailure('domain-invalid');
    }
    const parsed = parsePublicHostname(domainToASCII(typed));
    if (!parsed.ok) {
      throw new DomainsFailure(
        parsed.problem === 'not-public' ? 'domain-not-public' : 'domain-invalid',
      );
    }
    if (this.#reserved.has(parsed.hostname)) {
      throw new DomainsFailure('domain-reserved');
    }
    return parsed.hostname;
  }

  async #require(tx: DbTransaction, id: string): Promise<BrandDomain> {
    const row = await this.#repository.lock(tx, id);
    if (row === undefined) {
      throw new NotFoundException('No such domain');
    }
    return row;
  }

  async #requestCheck({ tx, brandId }: TicketingContext, domainId: string): Promise<void> {
    await enqueueOutbox(tx, {
      brandId,
      event: DOMAIN_CHECK_REQUESTED_EVENT,
      payload: { domainId },
    });
  }

  async #audit(
    { tx, brandId, actor }: TicketingContext,
    action: DomainsAuditAction,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action,
      targetType: 'brand_domain',
      targetId,
      meta,
    });
  }

  #view(row: BrandDomain): CustomDomain {
    return toCustomDomain(row, this.#cnameTarget);
  }
}
