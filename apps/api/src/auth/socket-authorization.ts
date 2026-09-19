import type { SocketError } from '@helpdock/schemas';
import { z } from 'zod';
import { INSTALL_ADMIN, isInstallAdmin, principalHasPermission } from './permissions.js';
import type { Principal } from './principal.js';
import type { RouteDeclaration } from './route-declaration.js';
import { isNamedBrand } from './target-brand.js';

/**
 * Layer 1 of DOMAIN-RULES §1.3 for the WebSocket transport: "role and scope
 * check per route **or event**, declared with a decorator such as
 * `@Requires('ticket:write')`".
 *
 * It is the same decision as the HTTP one and it is made with the same two
 * functions — `routeDeclarationOf` reads the decorator, `principalHasPermission`
 * answers it — so a socket event can never be more permissive than the REST
 * read it mirrors. Two things differ, and only two:
 *
 * 1. There is no path to take the target brand from, so a message names it.
 * 2. There is no request transaction, so nothing is recorded on a context; a
 *    socket event that reads the database opens its own scope when M1 adds one.
 */

export type SocketAuthorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SocketError };

const refuse = (code: SocketError['code'], message: string): SocketAuthorization => ({
  ok: false,
  error: { code, message },
});

/**
 * Every brand-scoped event names its brand. Nothing is inferred from the
 * socket, and the install sentinel is refused for the same reason
 * `resolveTargetBrand` refuses it on a path: it is the scope
 * `@Requires('install:admin')` gates, not a brand anyone has a role in.
 */
const brandNamingSchema = z.object({ brandId: z.uuid().refine(isNamedBrand) });

export interface AuthorizeSocketMessageInput {
  /** What the handler declared, or `undefined` when it declared nothing. */
  readonly declaration: RouteDeclaration | undefined;
  /** The principal the handshake put on the socket, or `null`. */
  readonly principal: Principal | null;
  /** The message body, untrusted. */
  readonly data: unknown;
}

export const authorizeSocketMessage = ({
  declaration,
  principal,
  data,
}: AuthorizeSocketMessageInput): SocketAuthorization => {
  if (declaration === undefined) {
    // "Missing decorator fails the request in development and in CI"
    // (DOMAIN-RULES §1.3). An event nobody declared is an event nobody
    // reviewed, and silence may never mean "allow".
    return refuse('forbidden', 'This event declares no permission');
  }

  if (declaration.kind === 'public') {
    return { ok: true };
  }

  if (principal === null) {
    return refuse('unauthenticated', 'This socket carries no principal');
  }

  if (declaration.kind === 'authenticated') {
    return { ok: true };
  }

  if (declaration.permission === INSTALL_ADMIN) {
    return isInstallAdmin(principal)
      ? { ok: true }
      : refuse('forbidden', 'This event is restricted to install administrators');
  }

  const named = brandNamingSchema.safeParse(data);
  if (!named.success) {
    return refuse(
      'invalid_payload',
      'This event acts on one brand and the message does not name one',
    );
  }

  return principalHasPermission(principal, named.data.brandId, declaration.permission)
    ? { ok: true }
    : refuse('forbidden', `Missing permission ${declaration.permission}`);
};
