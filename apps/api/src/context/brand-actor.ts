import type { DbTransaction } from '@helpdock/db';
import { getTx, requireRequestContext } from './request-context.js';

/**
 * Who is acting in which brand, for a route that a staff member and an API key
 * may both reach (M8): the Admin's webhook settings and the public API's
 * webhook routes share one service, and its audit rows have to say which of
 * the two made the change.
 *
 * Built from what the guards already proved — the principal and the brand the
 * permission was checked in — never from a parameter.
 */
interface BrandActorBase {
  readonly tx: DbTransaction;
  readonly brandId: string;
  /** The staff member's user id, or the API key's id. */
  readonly principalId: string;
}

export type BrandActor =
  | (BrandActorBase & { readonly principalType: 'staff' })
  /** A key is held to the scopes it was issued with, wherever a route is shared with staff. */
  | (BrandActorBase & { readonly principalType: 'apikey'; readonly scopes: readonly string[] });

export const brandActor = (): BrandActor => {
  const request = requireRequestContext();
  const { principal, targetBrandId } = request;

  /* c8 ignore next 3 -- the permission guard refuses anything else before a handler runs. */
  if (principal === null || targetBrandId === null) {
    throw new Error('A brand route ran without a principal in a brand');
  }
  if (principal.type !== 'staff' && principal.type !== 'apikey') {
    throw new Error(`A brand route ran for a ${principal.type} principal`);
  }

  const base = { tx: getTx(), brandId: targetBrandId, principalId: principal.id };

  return principal.type === 'apikey'
    ? { ...base, principalType: 'apikey', scopes: principal.scopes }
    : { ...base, principalType: 'staff' };
};
