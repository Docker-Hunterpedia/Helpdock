import type { ApiScope } from '@helpdock/schemas';
import type { Principal } from '../auth/principal.js';
import { requireRequestContext } from '../context/request-context.js';

/**
 * The API key behind an `/api/v1` request. Every route there requires a scope,
 * which no staff role holds, so the guard has already refused anything else.
 */
export type ApiKeyPrincipal = Extract<Principal, { type: 'apikey' }>;

export const apiKeyPrincipal = (): ApiKeyPrincipal => {
  const { principal } = requireRequestContext();
  /* c8 ignore next 3 -- the permission guard refuses anything else before a handler runs. */
  if (principal?.type !== 'apikey') {
    throw new Error('A public API route ran without an API key principal');
  }
  return principal;
};

/** Whether the key also holds `scope` — a ticket read names its contact only with `contacts:read`. */
export const keyHolds = (scope: ApiScope): boolean => apiKeyPrincipal().scopes.includes(scope);
