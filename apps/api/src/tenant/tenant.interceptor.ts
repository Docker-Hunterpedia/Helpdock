import { type Db, type TenantContext, withTenant } from '@helpdock/db';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { Principal } from '../auth/principal.js';
import { currentRequestContext, type RequestContext } from '../context/request-context.js';
import { DB } from '../runtime/tokens.js';
import { auditInstallScopeAccess } from './install-scope.js';
import { tenantScopeFor } from './tenant-scope.js';

/**
 * Step 3 of ARCHITECTURE §6: open the transaction the whole request runs in and
 * put the `app.*` settings on it, so every query the handler makes is subject to
 * the row-level security policies (DOMAIN-RULES §1.3).
 *
 * One transaction per request also settles the failure case for free: the
 * handler throwing rolls back everything it wrote, including the audit row an
 * install-scope route was charged for.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  readonly #db: Db;

  constructor(@Inject(DB) db: Db) {
    this.#db = db;
  }

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (executionContext.getType() !== 'http') {
      return next.handle();
    }

    const context = currentRequestContext();
    // `@Public()` routes have no principal and no tenant context; they may not
    // query a tenant table, and `getTx()` says so if they try.
    if (context?.principal == null || context.scopeKind === null) {
      return next.handle();
    }

    const tenantContext = tenantScopeFor({
      principal: context.principal,
      scopeKind: context.scopeKind,
      targetBrandId: context.targetBrandId,
    });

    if (tenantContext === null) {
      return next.handle();
    }

    return from(
      this.#runInTransaction({
        context,
        principal: context.principal,
        tenantContext,
        next,
      }),
    );
  }

  #runInTransaction({
    context,
    principal,
    tenantContext,
    next,
  }: {
    context: RequestContext;
    principal: Principal;
    tenantContext: TenantContext;
    next: CallHandler;
  }): Promise<unknown> {
    return withTenant(this.#db, tenantContext, async (tx) => {
      context.tx = tx;
      try {
        if (context.scopeKind === 'install') {
          await auditInstallScopeAccess(tx, context, principal);
        }
        return await lastValueFrom(next.handle());
      } finally {
        context.tx = null;
      }
    });
  }
}
