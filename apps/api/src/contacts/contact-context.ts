import { getTx, requireRequestContext } from '../context/request-context.js';
import type { ContactContext } from './contacts.service.js';

/**
 * Who is asking, built from the principal the guard resolved rather than from a
 * fresh read: the claims are what the permission was checked against, and a
 * second source would be a second answer to "who is asking?".
 *
 * Shared by both controllers, because both act on the same brand with the same
 * actor and only the noun differs.
 */
export const contactContext = (): ContactContext => {
  const request = requireRequestContext();
  const principal = request.principal;
  const brandId = request.targetBrandId;

  /* c8 ignore next 6 -- the permission guard has already refused anything else. */
  if (principal === null || principal.type !== 'staff' || brandId === null) {
    throw new Error('A contact route ran without a staff principal in a brand');
  }

  const membership = principal.brands[brandId];
  /* c8 ignore next 3 -- `contact:read` is only held through a membership. */
  if (membership === undefined) {
    throw new Error('A contact route ran without a membership in its target brand');
  }

  return {
    tx: getTx(),
    brandId,
    actor: { userId: principal.id, role: membership.role },
  };
};
