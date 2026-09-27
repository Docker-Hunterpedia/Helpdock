import type { Db, DbTransaction, WidgetVisitor } from '@helpdock/db';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import { withSystemJob } from '../tenant/system-job.js';
import { isOriginAllowed } from './origin.js';
import { type ResolvedWidgetSettings, resolveWidgetSettings } from './resolved-settings.js';
import { hashVisitorSecret, visitorSecretFrom } from './visitor-credential.js';
import type { WidgetRepository } from './widget.repository.js';
import { WidgetFailure } from './widget-failure.js';
import type { WidgetBrand, WidgetSettingsRepository } from './widget-settings.repository.js';

/**
 * The front door of every widget request (M4-02, M4-03), HTTP and socket
 * alike, in the order that costs least first:
 *
 * 1. **Per-address throttle** (Redis), before anything touches Postgres.
 * 2. **The brand**, active, and its widget settings.
 * 3. **The origin**, against the brand's allow-list: config, session, socket
 *    handshake and every other route.
 * 4. **The visitor**, from `Authorization: Visitor <secret>`, looked up by the
 *    hash of the secret inside the brand — a secret another brand issued is
 *    not found here.
 * 5. **Per-visitor throttle** on writes.
 *
 * **This is an explicit system path** (AGENTS.md). A visitor has no staff
 * session and no department, so the work runs in a transaction scoped to
 * exactly the one brand the path names, as the system principal
 * `widget:<visitorId>` — the way `csat.service.ts` serves its public page and
 * the inbound email router files mail. What a visitor may then reach inside
 * the brand is `conversation-access.ts`, applied to every ticket read; what
 * they change is recorded in `ticket_activity` under their visitor id.
 */

/** Every widget request from one address to one brand. */
export const WIDGET_IP_RULE: RateLimitRule = {
  bucket: 'widget-ip',
  limit: 300,
  windowSeconds: 300,
};

/** New visitors from one address: a page reload keeps its secret, so this only counts fresh starts. */
export const WIDGET_SESSION_RULE: RateLimitRule = {
  bucket: 'widget-session',
  limit: 30,
  windowSeconds: 600,
};

/** Messages, uploads and transcripts from one visitor. */
export const WIDGET_VISITOR_WRITE_RULE: RateLimitRule = {
  bucket: 'widget-visitor-write',
  limit: 30,
  windowSeconds: 60,
};

export interface WidgetRequestFacts {
  readonly origin: string | string[] | undefined;
  readonly authorization?: string | string[] | undefined;
  readonly ip: string | null;
  /** An event on a `/widget` socket whose handshake passed this gate. */
  readonly viaSocket?: boolean;
}

export interface WidgetScope {
  readonly tx: DbTransaction;
  readonly brand: WidgetBrand;
  readonly settings: ResolvedWidgetSettings;
}

export interface VisitorScope extends WidgetScope {
  readonly visitor: WidgetVisitor;
}

export interface WidgetGateDependencies {
  readonly db: Db;
  readonly settings: WidgetSettingsRepository;
  readonly widget: WidgetRepository;
  readonly limiter: RateLimiter;
}

export class WidgetGate {
  readonly #deps: WidgetGateDependencies;

  constructor(deps: WidgetGateDependencies) {
    this.#deps = deps;
  }

  /** A brand-level request with no visitor: the config, the availability. */
  async brand<T>(
    brandId: string,
    facts: WidgetRequestFacts,
    fn: (scope: WidgetScope) => Promise<T>,
  ): Promise<T> {
    await this.#throttle(WIDGET_IP_RULE, `${brandId}:${facts.ip ?? 'unknown'}`);

    return withSystemJob(this.#deps.db, brandId, 'widget:config', async (tx) =>
      fn(await this.#scope(tx, brandId, facts)),
    );
  }

  /**
   * A request on behalf of a visitor. `write` adds the per-visitor throttle.
   * An event on an open socket skips the per-address one, which its handshake
   * already paid — typing and read events would otherwise spend a page's budget.
   * The visitor's `last_seen_at` is kept to the minute, which is what
   * retention sweeps by, without a write on every read.
   */
  async visitor<T>(
    brandId: string,
    facts: WidgetRequestFacts,
    options: { readonly write: boolean },
    fn: (scope: VisitorScope) => Promise<T>,
  ): Promise<T> {
    if (facts.viaSocket !== true) {
      await this.#throttle(WIDGET_IP_RULE, `${brandId}:${facts.ip ?? 'unknown'}`);
    }
    const secret = visitorSecretFrom(facts.authorization);
    if (secret === null) {
      throw new WidgetFailure('unauthenticated');
    }
    const secretHash = hashVisitorSecret(secret);

    return withSystemJob(this.#deps.db, brandId, 'widget', async (tx) => {
      const scope = await this.#scope(tx, brandId, facts);
      const found = await this.#deps.widget.visitorByHash(tx, secretHash);
      if (found === undefined) {
        throw new WidgetFailure('unauthenticated');
      }
      if (options.write) {
        await this.#throttle(WIDGET_VISITOR_WRITE_RULE, found.id);
      }
      const visitor =
        Date.now() - found.lastSeenAt.getTime() > 60_000
          ? await this.#deps.widget.updateVisitor(tx, found.id, { lastSeenAt: new Date() })
          : found;

      return fn({ ...scope, visitor });
    });
  }

  /**
   * The session route: the visitor when the request carries a secret this
   * brand issued, otherwise none — and then `fresh` is the throttle a new
   * visitor costs, since each one is a row.
   */
  async session<T>(
    brandId: string,
    facts: WidgetRequestFacts,
    fn: (scope: WidgetScope & { readonly visitor: WidgetVisitor | undefined }) => Promise<T>,
  ): Promise<T> {
    await this.#throttle(WIDGET_IP_RULE, `${brandId}:${facts.ip ?? 'unknown'}`);
    const secret = visitorSecretFrom(facts.authorization);

    return withSystemJob(this.#deps.db, brandId, 'widget', async (tx) => {
      const scope = await this.#scope(tx, brandId, facts);
      const visitor =
        secret === null
          ? undefined
          : await this.#deps.widget.visitorByHash(tx, hashVisitorSecret(secret));
      if (visitor === undefined) {
        await this.#throttle(WIDGET_SESSION_RULE, `${brandId}:${facts.ip ?? 'unknown'}`);
      }
      return fn({ ...scope, visitor });
    });
  }

  /** The socket handshake's check: brand, origin and visitor in one read. */
  async handshake(
    brandId: string,
    facts: WidgetRequestFacts,
    secret: string,
  ): Promise<{ readonly visitorId: string; readonly settings: ResolvedWidgetSettings }> {
    await this.#throttle(WIDGET_IP_RULE, `${brandId}:${facts.ip ?? 'unknown'}`);

    return withSystemJob(this.#deps.db, brandId, 'widget:handshake', async (tx) => {
      const scope = await this.#scope(tx, brandId, facts);
      const visitor = await this.#deps.widget.visitorByHash(tx, hashVisitorSecret(secret));
      if (visitor === undefined) {
        throw new WidgetFailure('unauthenticated');
      }
      return { visitorId: visitor.id, settings: scope.settings };
    });
  }

  async #scope(
    tx: DbTransaction,
    brandId: string,
    facts: WidgetRequestFacts,
  ): Promise<WidgetScope> {
    const brand = await this.#deps.settings.brand(tx, brandId);
    if (brand?.status !== 'active') {
      throw new WidgetFailure('unavailable');
    }
    const settings = resolveWidgetSettings(await this.#deps.settings.row(tx, brandId));
    if (!isOriginAllowed(facts.origin, settings.allowedOrigins)) {
      throw new WidgetFailure('origin_not_allowed');
    }

    return { tx, brand, settings };
  }

  async #throttle(rule: RateLimitRule, subject: string): Promise<void> {
    if (!(await this.#deps.limiter.consume(rule, subject))) {
      throw new WidgetFailure('rate_limited');
    }
  }
}
