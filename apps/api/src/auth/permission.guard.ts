import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requireRequestContext } from '../context/request-context.js';
import type { Logger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';
import { INSTALL_ADMIN, isInstallAdmin, principalHasPermission } from './permissions.js';
import { type RouteDeclaration, routeDeclarationOf } from './route-declaration.js';
import { resolveTargetBrand } from './target-brand.js';

interface RoutedRequest {
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Layer 1 of DOMAIN-RULES §1.3, and the place the request's tenant scope is
 * decided. It runs after {@link ./auth.guard.js AuthGuard}, so a principal is
 * present for everything but a `@Public()` route.
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
    if (context.getType() !== 'http') {
      // A socket authenticates on handshake and authorises room joins with the
      // same checks as the matching REST read (DOMAIN-RULES §1.4). That gateway
      // is M0-13 and does not exist yet, so anything arriving here is refused:
      // it is the guard's job to fail closed, and M0-13 has to say what a
      // socket event needs rather than inherit silence.
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
      throw new BadRequestException(
        target.reason === 'invalid'
          ? 'brandId must be a UUID'
          : 'This route acts on one brand and the request does not name one',
      );
    }

    if (!principalHasPermission(principal, target.brandId, declaration.permission)) {
      throw new ForbiddenException(`Missing permission ${declaration.permission}`);
    }

    requestContext.targetBrandId = target.brandId;
    requestContext.scopeKind = 'brand';
    return true;
  }
}
