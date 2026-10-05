import { type Db, type DbTransaction, type TenantContext, withTenant } from '@helpdock/db';
import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { NoRequestContextError, requireRequestContext } from '../context/request-context.js';

/**
 * A route that calls a model (M7-05 agent assist) must not hold the request's
 * transaction open for the seconds a model takes (docs/guides/ai.md, ADR
 * 0021). `@StepTransactions()` tells the {@link ./tenant.interceptor.js
 * TenantInterceptor} to resolve the same tenant context — the same brand, the
 * same department policy, the same principal — and open no transaction; the
 * handler opens a short one per step with {@link inRequestTenant}: read and
 * authorise, call the model with none open, then write the result.
 *
 * Every step is under row-level security exactly as a whole-request
 * transaction is. What is lost is atomicity across the steps, so the routes
 * that use it write at most once, after the model has answered.
 */

export const STEP_TRANSACTIONS = 'helpdock:step-transactions';

export const StepTransactions = (): CustomDecorator<string> =>
  SetMetadata<string, boolean>(STEP_TRANSACTIONS, true);

/** One short transaction under the request's own tenant context. */
export const inRequestTenant = <T>(db: Db, fn: (tx: DbTransaction) => Promise<T>): Promise<T> => {
  const context = requireRequestContext();
  if (context.tenant === null) {
    throw new NoRequestContextError('The tenant context of a step-transaction route');
  }
  const tenant: TenantContext = context.tenant;
  return withTenant(db, tenant, fn);
};
