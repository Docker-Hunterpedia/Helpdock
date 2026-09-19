import { BadRequestException, Controller, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import type { Logger } from '../logging/logger.js';
import { fakeExecutionContext } from '../testing/execution-context.js';
import { silentLogger } from '../testing/silent-logger.js';
import { PermissionGuard } from './permission.guard.js';
import type { Principal } from './principal.js';
import { Authenticated, Public, Requires } from './route-declaration.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const USER = '01937f5e-7e53-7000-8000-000000000001';

@Controller()
class Routes {
  @Get('open')
  @Public()
  open(): void {}

  @Get('me')
  @Authenticated()
  me(): void {}

  @Get('brand')
  @Requires('brand:read')
  brand(): void {}

  @Get('install')
  @Requires('install:admin')
  install(): void {}

  @Get('undeclared')
  undeclared(): void {}
}

type RouteName = 'open' | 'me' | 'brand' | 'install' | 'undeclared';

const staff = (
  brands: Record<
    string,
    { role: 'admin' | 'team_leader' | 'agent' | 'viewer'; departmentIds: string[] | 'all' }
  >,
  installAdmin = false,
): Principal => ({ type: 'staff', id: USER, brands, installAdmin });

interface RunOptions {
  readonly route: RouteName;
  readonly principal?: Principal;
  readonly params?: Record<string, unknown>;
  readonly hostBrandId?: string;
  readonly logger?: Logger;
}

const run = ({ route, principal, params, hostBrandId, logger = silentLogger() }: RunOptions) => {
  const guard = new PermissionGuard(new Reflector(), logger);
  const context = new RequestContext({ requestId: 'r', method: 'GET', path: `/${route}` });
  context.principal = principal ?? null;
  context.hostBrandId = hostBrandId ?? null;

  return runInRequestContext(context, () => ({
    allowed: guard.canActivate(
      fakeExecutionContext({
        handler: Routes.prototype[route],
        controller: Routes,
        ...(params === undefined ? {} : { request: { params } }),
      }),
    ),
    context,
  }));
};

describe('PermissionGuard', () => {
  it('lets a public route through', () => {
    expect(run({ route: 'open' }).allowed).toBe(true);
  });

  it('refuses a route that declares nothing, and says so in the log', () => {
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');

    expect(() => run({ route: 'undeclared', principal: staff({}), logger })).toThrow(
      ForbiddenException,
    );
    expect(error).toHaveBeenCalledOnce();
  });

  describe('@Authenticated()', () => {
    it('scopes the transaction to the principal, not to one brand', () => {
      const { allowed, context } = run({
        route: 'me',
        principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [] } }),
      });

      expect(allowed).toBe(true);
      expect(context.scopeKind).toBe('principal');
      expect(context.targetBrandId).toBeNull();
    });
  });

  describe('@Requires(permission)', () => {
    it('allows a principal with the permission in the brand named by the path', () => {
      const { allowed, context } = run({
        route: 'brand',
        principal: staff({
          [BRAND_A]: { role: 'viewer', departmentIds: 'all' },
          [BRAND_B]: { role: 'admin', departmentIds: 'all' },
        }),
        params: { brandId: BRAND_B },
      });

      expect(allowed).toBe(true);
      expect(context.targetBrandId).toBe(BRAND_B);
      expect(context.scopeKind).toBe('brand');
    });

    it("refuses another brand's staff", () => {
      expect(() =>
        run({
          route: 'brand',
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          params: { brandId: BRAND_B },
        }),
      ).toThrow(ForbiddenException);
    });

    it('refuses a brand id that is not a uuid', () => {
      expect(() =>
        run({
          route: 'brand',
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          params: { brandId: 'nope' },
        }),
      ).toThrow(BadRequestException);
    });

    it('refuses to guess a brand for a principal that holds several', () => {
      expect(() =>
        run({
          route: 'brand',
          principal: staff({
            [BRAND_A]: { role: 'admin', departmentIds: 'all' },
            [BRAND_B]: { role: 'admin', departmentIds: 'all' },
          }),
          params: {},
        }),
      ).toThrow(BadRequestException);
    });

    it('uses the brand the host named when the path does not', () => {
      const { context } = run({
        route: 'brand',
        principal: staff({
          [BRAND_A]: { role: 'admin', departmentIds: 'all' },
          [BRAND_B]: { role: 'admin', departmentIds: 'all' },
        }),
        params: {},
        hostBrandId: BRAND_A,
      });

      expect(context.targetBrandId).toBe(BRAND_A);
    });
  });

  describe("@Requires('install:admin')", () => {
    it('refuses staff who are not install admins, whatever their brand role', () => {
      expect(() =>
        run({
          route: 'install',
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        }),
      ).toThrow(ForbiddenException);
    });

    it('puts an install admin into install scope', () => {
      const { allowed, context } = run({ route: 'install', principal: staff({}, true) });

      expect(allowed).toBe(true);
      expect(context.scopeKind).toBe('install');
    });
  });

  it('refuses when no principal reached the context, even on a declared route', () => {
    expect(() => run({ route: 'me' })).toThrow(ForbiddenException);
  });

  it('refuses a transport that has no authorization rules yet, rather than inheriting silence', () => {
    // The socket gateway is M0-13. Until it says what a socket event needs, an
    // event reaching the global guards must be refused, not waved through.
    const guard = new PermissionGuard(new Reflector(), silentLogger());

    expect(() => guard.canActivate(fakeExecutionContext({ type: 'ws' }))).toThrow(
      ForbiddenException,
    );
  });
});
