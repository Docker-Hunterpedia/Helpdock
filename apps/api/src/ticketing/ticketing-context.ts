import type { DbTransaction } from '@helpdock/db';
import type { BrandRole } from '@helpdock/schemas';
import { getTx, requireRequestContext } from '../context/request-context.js';

/**
 * What every write in this module is given: the request's transaction, the
 * brand the route named, and who is asking.
 *
 * The same shape as `brands/departments.service.ts`'s `DepartmentContext`, and
 * for the same reasons. The transaction is the caller's, so reads are already
 * narrowed by row-level security and an audit row rolls back with the change it
 * described. The actor is built from the principal the guard resolved rather
 * than from a fresh read, because the claims are what the permission was
 * checked against and a second source would be a second answer to "who is
 * asking?".
 *
 * `departmentIds` is here for the one rule in this module that needs it: a
 * template names the department its tickets are filed in, and DOMAIN-RULES §1.2
 * gives a Team Leader only "departments they lead".
 */
export interface TicketingActor {
  readonly userId: string;
  readonly role: BrandRole;
  /** `'all'` for an Admin, and for an unrestricted Team Leader. */
  readonly departmentIds: readonly string[] | 'all';
}

export interface TicketingContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: TicketingActor;
}

/**
 * The context for the request being handled. One function rather than a private
 * method on each of the three controllers, because all three ask the same
 * question and a copy is a place for the answers to drift apart.
 */
export const requireTicketingContext = (): TicketingContext => {
  const request = requireRequestContext();
  const principal = request.principal;
  const brandId = request.targetBrandId;

  /* c8 ignore next 6 -- the permission guard has already refused anything else. */
  if (principal === null || principal.type !== 'staff' || brandId === null) {
    throw new Error('A ticketing route ran without a staff principal in a brand');
  }

  const membership = principal.brands[brandId];
  /* c8 ignore next 3 -- `ticketing:manage` is only held through a membership. */
  if (membership === undefined) {
    throw new Error('A ticketing route ran without a membership in its target brand');
  }

  return {
    tx: getTx(),
    brandId,
    actor: {
      userId: principal.id,
      role: membership.role,
      departmentIds: membership.departmentIds,
    },
  };
};
