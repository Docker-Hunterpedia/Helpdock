import type { ExecutionContext } from '@nestjs/common';
import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Permission } from './permissions.js';

/**
 * "Route handlers declare `@Requires('<permission>')`; a CI check fails on any
 * route without one" (ARCHITECTURE §6). Three decorators cover every case, and
 * a handler that carries none of them is refused at runtime as well as in CI
 * (DOMAIN-RULES §1.3), because silence must never mean "allow".
 *
 * | Decorator | Principal | Transaction |
 * |---|---|---|
 * | `@Public()` | none | none |
 * | `@Authenticated()` | required | the principal's own brands |
 * | `@Requires(permission)` | required, with the permission in the target brand | the target brand |
 * | `@Requires('install:admin')` | required, `installAdmin` | install scope, audited |
 */

export const ROUTE_DECLARATION = 'helpdock:route-declaration';

export type RouteDeclaration =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permission'; readonly permission: Permission };

/** Reachable without a principal: the probes, and from M5 the help center. */
export const Public = (): CustomDecorator<string> =>
  SetMetadata<string, RouteDeclaration>(ROUTE_DECLARATION, { kind: 'public' });

/**
 * A principal is required but no permission is: the route answers about the
 * principal itself, so there is nothing else to authorise against.
 */
export const Authenticated = (): CustomDecorator<string> =>
  SetMetadata<string, RouteDeclaration>(ROUTE_DECLARATION, { kind: 'authenticated' });

export const Requires = (permission: Permission): CustomDecorator<string> =>
  SetMetadata<string, RouteDeclaration>(ROUTE_DECLARATION, { kind: 'permission', permission });

/** The handler's declaration, or the controller's when the handler has none. */
export const routeDeclarationOf = (
  reflector: Reflector,
  context: ExecutionContext,
): RouteDeclaration | undefined =>
  reflector.getAllAndOverride<RouteDeclaration | undefined>(ROUTE_DECLARATION, [
    context.getHandler(),
    context.getClass(),
  ]);
