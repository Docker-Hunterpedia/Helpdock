import { AsyncLocalStorage } from 'node:async_hooks';
import type { DbTransaction } from '@helpdock/db';
import type { Principal } from '../auth/principal.js';

/**
 * Step 1 of the request lifecycle in ARCHITECTURE §6. Everything a request
 * accumulates — its id, the brand its host named, the principal the guard
 * resolved, the transaction the interceptor opened — lives here, so a service
 * reads it without every signature growing a context parameter.
 *
 * The store is mutable on purpose: the guard and the interceptor fill in fields
 * the middleware could not know yet. It is created once per request and is
 * never shared between two.
 */

/** Which brands a route's transaction may name. Decided by the permission guard. */
export type TenantScopeKind =
  /** One brand: the route's target. */
  | 'brand'
  /** Every brand the principal holds a role in. `/api/me` and `/api/brands`. */
  | 'principal'
  /** `INSTALL_SCOPE_BRAND_ID`: an install-admin path, audited on entry. */
  | 'install';

export class RequestContext {
  readonly requestId: string;
  readonly startedAt: bigint;
  readonly method: string;
  /**
   * Path only. A query string may carry a search term, which is a body by
   * another name.
   *
   * Writable because a path can itself be a credential: the magic-link route
   * takes its token as a path parameter, and the handler replaces that segment
   * before the line is written. The log is read by more people than the
   * database is, and a single-use token in it is a working one until it is
   * spent.
   */
  path: string;

  /** Brand named by the `Host` header, for help-center and widget requests. Null otherwise. */
  hostBrandId: string | null = null;
  principal: Principal | null = null;
  /** The brand the route acts on, once the permission guard has resolved it. */
  targetBrandId: string | null = null;
  scopeKind: TenantScopeKind | null = null;
  /** The open transaction, for the duration of the handler only. */
  tx: DbTransaction | null = null;

  constructor(options: { requestId: string; method: string; path: string }) {
    this.requestId = options.requestId;
    this.method = options.method;
    this.path = options.path;
    this.startedAt = process.hrtime.bigint();
  }

  get durationMs(): number {
    const NANOS_PER_MILLI = 1_000_000;
    return Number(process.hrtime.bigint() - this.startedAt) / NANOS_PER_MILLI;
  }
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runInRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const currentRequestContext = (): RequestContext | undefined => storage.getStore();

/** Thrown when code that assumes a request runs outside one. Always a programming error. */
export class NoRequestContextError extends Error {
  constructor(what: string) {
    super(`${what} is only available inside a request; no request context is active`);
    this.name = 'NoRequestContextError';
  }
}

export const requireRequestContext = (): RequestContext => {
  const context = storage.getStore();
  if (context === undefined) {
    throw new NoRequestContextError('The request context');
  }
  return context;
};

/**
 * The transaction the {@link ../tenant/tenant.interceptor.js TenantInterceptor}
 * opened, carrying the `app.*` settings row-level security reads. Every query a
 * request makes goes through it; a query made any other way sees nothing
 * (DOMAIN-RULES §1.3).
 */
export const getTx = (): DbTransaction => {
  const context = requireRequestContext();
  if (context.tx === null) {
    throw new NoRequestContextError('The tenant transaction');
  }
  return context.tx;
};
