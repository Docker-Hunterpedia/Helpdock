import { brandIdParamSchema } from '@helpdock/schemas';
import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { requireRequestContext } from '../context/request-context.js';
import type { Logger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';
import { INSTALL_ADMIN, isInstallAdmin, principalHasPermission } from './permissions.js';
import type { Principal } from './principal.js';
import { type RouteDeclaration, routeDeclarationOf } from './route-declaration.js';
import { authorizeSocketMessage } from './socket-authorization.js';
import { BRAND_ID_PARAM, resolveTargetBrand } from './target-brand.js';

interface RoutedRequest {
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Why a request named no brand this route can act on.
 *
 * Nest runs guards before pipes, so a brand-scoped route's `:brandId` is read
 * here first and the handler's `@Param(new ZodValidationPipe(BrandIdParamDto))`
 * never sees a malformed one. It is refused with that same schema, so the
 * client is told which field is wrong — `fields: [{ path: 'brandId' }]` — rather
 * than handed a sentence it cannot map back to an input (issue #36).
 *
 * The other two refusals are not about a field: a well-formed id that names the
 * install sentinel is refused because only `@Requires('install:admin')` opens
 * that scope, and a route that takes its brand from the `Host` header has no
 * path parameter to blame.
 */
const badTargetBrand = (
  reason: 'invalid' | 'ambiguous',
  params: Readonly<Record<string, unknown>> | undefined,
): Error => {
  if (reason === 'ambiguous') {
    return new BadRequestException(
      'This route acts on one brand and the request does not name one',
    );
  }

  if (params?.[BRAND_ID_PARAM] === undefined) {
    return new BadRequestException('The host does not name a brand this route can act on');
  }

  const parsed = brandIdParamSchema.safeParse(params);
  return parsed.success
    ? new BadRequestException('brandId may not name the install scope')
    : parsed.error;
};

/**
 * Layer 1 of DOMAIN-RULES §1.3, and the place the request's tenant scope is
 * decided. It runs after {@link ./auth.guard.js AuthGuard}, so a principal is
 * present for everything but a `@Public()` route.
 *
 * It is global, so it covers both transports §1.3 names: HTTP routes, where the
 * target brand comes from the path or the host, and `@SubscribeMessage` events
 * on the `/staff` namespace, where it comes from the message
 * ({@link ./socket-authorization.js authorizeSocketMessage}). One guard, one
 * matrix, one place to read.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  readonly #reflector: Reflector;
  readonly #logger: Logger;

  constructor(@Inject(Reflector) reflector: Reflector, @Inject(LOGGER) logger: Logger) {
    this.#reflector = reflector;
    this.#logger = logger;
  }

  canActivate(context: ExecutionContext): boolean {
    const transport = context.getType();
    if (transport === 'ws') {
      // "A socket authenticates on handshake exactly like HTTP. Joining a room
      // runs the same permission check as the corresponding REST read"
      // (DOMAIN-RULES §1.4). Same decorators, same matrix, same guard.
      return this.#authorizeSocket(context);
    }
    if (transport !== 'http') {
      // It is the guard's job to fail closed: a transport nobody has written
      // rules for gets none of them by default.
      throw new ForbiddenException('This transport has no authorization rules yet');
    }

    const declaration = routeDeclarationOf(this.#reflector, context);
    if (declaration === undefined) {
      // "Missing decorator fails the request in development and in CI"
      // (DOMAIN-RULES §1.3). It fails it in production too: a route nobody
      // declared is a route nobody reviewed.
      this.#logger.error(
        { controller: context.getClass().name, handler: context.getHandler().name },
        'Route has no @Public, @Authenticated or @Requires declaration and was refused',
      );
      throw new ForbiddenException('This route declares no permission');
    }

    if (declaration.kind === 'public') {
      return true;
    }

    return this.#authorize(declaration, context);
  }

  /**
   * The socket half. It throws a `WsException` carrying the `SocketError` shape
   * rather than an HTTP exception, so the gateway's filter can hand the refusal
   * back through the event's acknowledgement instead of leaving the caller to
   * guess (`realtime/ack-exception.filter.ts`).
   */
  #authorizeSocket(context: ExecutionContext): boolean {
    const declaration = routeDeclarationOf(this.#reflector, context);
    const socket = context.switchToWs().getClient<{ data?: { principal?: Principal } }>();

    const authorization = authorizeSocketMessage({
      declaration,
      principal: socket.data?.principal ?? null,
      data: context.switchToWs().getData(),
    });

    if (authorization.ok) {
      return true;
    }

    if (declaration === undefined) {
      this.#logger.error(
        { gateway: context.getClass().name, handler: context.getHandler().name },
        'Socket event has no @Public, @Authenticated or @Requires declaration and was refused',
      );
    }

    throw new WsException(authorization.error);
  }

  #authorize(
    declaration: Exclude<RouteDeclaration, { kind: 'public' }>,
    context: ExecutionContext,
  ): boolean {
    const requestContext = requireRequestContext();
    const principal = requestContext.principal;
    if (principal === null) {
      throw new ForbiddenException('This route declares no permission');
    }

    if (declaration.kind === 'authenticated') {
      requestContext.scopeKind = 'principal';
      return true;
    }

    if (declaration.permission === INSTALL_ADMIN) {
      if (!isInstallAdmin(principal)) {
        throw new ForbiddenException('This route is restricted to install administrators');
      }
      requestContext.scopeKind = 'install';
      return true;
    }

    const request = context.switchToHttp().getRequest<RoutedRequest>();
    const target = resolveTargetBrand({
      principal,
      params: request.params,
      hostBrandId: requestContext.hostBrandId,
    });

    if (!target.ok) {
      throw badTargetBrand(target.reason, request.params);
    }

    if (!principalHasPermission(principal, target.brandId, declaration.permission)) {
      throw new ForbiddenException(`Missing permission ${declaration.permission}`);
    }

    requestContext.targetBrandId = target.brandId;
    requestContext.scopeKind = 'brand';
    return true;
  }
}
