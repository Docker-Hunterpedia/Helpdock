import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requireRequestContext } from '../context/request-context.js';
import { PRINCIPAL_RESOLVER } from '../runtime/tokens.js';
import type { PrincipalRequest, PrincipalResolver } from './principal-resolver.js';
import { routeDeclarationOf } from './route-declaration.js';

/**
 * Puts the principal on the request, or refuses it. The permission itself is
 * the next guard's business: this one only answers "who is this?".
 */
@Injectable()
export class AuthGuard implements CanActivate {
  readonly #reflector: Reflector;
  readonly #resolver: PrincipalResolver;

  // Every dependency is named with `@Inject`, never inferred from the parameter
  // type: an `import type` would erase the class the metadata needs, and the
  // formatter is free to rewrite an import it sees used only as a type.
  constructor(
    @Inject(Reflector) reflector: Reflector,
    @Inject(PRINCIPAL_RESOLVER) resolver: PrincipalResolver,
  ) {
    this.#reflector = reflector;
    this.#resolver = resolver;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // A socket authenticates once, at the handshake, in
    // `realtime/handshake.ts` — with this same resolver — and carries the
    // principal on itself afterwards (DOMAIN-RULES §1.4). There is nothing for
    // this guard to resolve on a socket event; `PermissionGuard` reads what the
    // handshake put there.
    if (context.getType() !== 'http') {
      return true;
    }

    if (routeDeclarationOf(this.#reflector, context)?.kind === 'public') {
      return true;
    }

    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    const principal = await this.#resolver.resolve(request);
    if (principal === null) {
      throw new UnauthorizedException('Authentication is required for this route');
    }

    requireRequestContext().principal = principal;
    return true;
  }
}
