import { INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { BadRequestException, Controller, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
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

    /**
     * The guard runs before the handler's pipe, so it is the guard that refuses
     * a malformed `:brandId` — and it does so with `brandIdParamSchema`, so the
     * body carries the field rather than a sentence (issue #36).
     */
    it('refuses a brand id that is not a uuid, naming the field', () => {
      let thrown: unknown;
      try {
        run({
          route: 'brand',
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          params: { brandId: 'nope' },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ZodError);
      expect((thrown as ZodError).issues.map((issue) => issue.path)).toEqual([['brandId']]);
    });

    it('refuses a path that names the install scope', () => {
      expect(() =>
        run({
          route: 'brand',
          principal: staff({ [INSTALL_SCOPE_BRAND_ID]: { role: 'admin', departmentIds: 'all' } }),
          params: { brandId: INSTALL_SCOPE_BRAND_ID },
        }),
      ).toThrow(BadRequestException);
    });

    it('refuses a host that names no brand this route can act on', () => {
      expect(() =>
        run({
          route: 'brand',
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          params: {},
          hostBrandId: INSTALL_SCOPE_BRAND_ID,
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

  it('refuses a transport that has no authorization rules, rather than inheriting silence', () => {
    const guard = new PermissionGuard(new Reflector(), silentLogger());

    expect(() => guard.canActivate(fakeExecutionContext({ type: 'rpc' }))).toThrow(
      ForbiddenException,
    );
  });
});

/**
 * The same guard, the same decorators and the same matrix over a socket
 * (DOMAIN-RULES §1.3: "role and scope check per route **or event**"). What
 * differs is where the brand comes from — the message, not the path — and that
 * a refusal is a `WsException` the gateway's filter can acknowledge with.
 */
describe('PermissionGuard over a socket', () => {
  const onSocket = ({
    event,
    principal,
    data,
    logger = silentLogger(),
  }: {
    readonly event: RouteName;
    readonly principal?: Principal;
    readonly data?: unknown;
    readonly logger?: Logger;
  }) =>
    new PermissionGuard(new Reflector(), logger).canActivate(
      fakeExecutionContext({
        type: 'ws',
        handler: Routes.prototype[event],
        controller: Routes,
        client: { data: principal === undefined ? {} : { principal } },
        data,
      }),
    );

  it('lets an @Authenticated() event through for any signed-in socket', () => {
    expect(onSocket({ event: 'me', principal: staff({}) })).toBe(true);
  });

  it('refuses an event whose socket carries no principal', () => {
    expect(() => onSocket({ event: 'me' })).toThrow(WsException);
  });

  it('allows a @Requires event for the brand the message names', () => {
    expect(
      onSocket({
        event: 'brand',
        principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [] } }),
        data: { brandId: BRAND_A },
      }),
    ).toBe(true);
  });

  /** The `SocketError` the guard refused with, so a test can read its code. */
  const refusalOf = (input: Parameters<typeof onSocket>[0]): unknown => {
    try {
      onSocket(input);
      return expect.unreachable('the guard should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(WsException);
      return (error as WsException).getError();
    }
  };

  it('refuses a @Requires event for a brand the principal has no role in', () => {
    expect(
      refusalOf({
        event: 'brand',
        principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        data: { brandId: BRAND_B },
      }),
    ).toMatchObject({ code: 'forbidden' });
  });

  it.each([
    ['names no brand', {}],
    [
      'names the install sentinel, which is a scope and not a brand',
      { brandId: INSTALL_SCOPE_BRAND_ID },
    ],
  ])('refuses a @Requires event that %s', (_name, data) => {
    expect(
      refusalOf({
        event: 'brand',
        principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        data,
      }),
    ).toMatchObject({ code: 'invalid_payload' });
  });

  it('refuses an event that declares nothing, and says so in the log', () => {
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');

    expect(() => onSocket({ event: 'undeclared', principal: staff({}), logger })).toThrow(
      WsException,
    );
    expect(error).toHaveBeenCalledOnce();
  });
});
