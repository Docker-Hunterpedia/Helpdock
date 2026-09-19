import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { fakeExecutionContext } from '../testing/execution-context.js';
import { AuthGuard } from './auth.guard.js';
import type { Principal } from './principal.js';
import { DenyAllPrincipalResolver, type PrincipalResolver } from './principal-resolver.js';
import { Authenticated, Public } from './route-declaration.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const principal: Principal = {
  type: 'staff',
  id: USER,
  brands: { [BRAND]: { role: 'agent', departmentIds: [] } },
  installAdmin: false,
};

@Controller()
class Routes {
  @Get('open')
  @Public()
  open(): void {}

  @Get('me')
  @Authenticated()
  me(): void {}
}

const alwaysResolves: PrincipalResolver = { resolve: () => Promise.resolve(principal) };

const guardWith = (resolver: PrincipalResolver): AuthGuard =>
  new AuthGuard(new Reflector(), resolver);

const handler = (name: 'open' | 'me') => Routes.prototype[name];

describe('AuthGuard', () => {
  it('lets a public route through without touching the resolver', async () => {
    const guard = guardWith({
      resolve: () => Promise.reject(new Error('the resolver must not be called')),
    });

    await expect(
      guard.canActivate(fakeExecutionContext({ handler: handler('open'), controller: Routes })),
    ).resolves.toBe(true);
  });

  it('puts the principal on the request context', async () => {
    const context = new RequestContext({ requestId: 'r', method: 'GET', path: '/api/me' });

    await runInRequestContext(context, () =>
      guardWith(alwaysResolves).canActivate(
        fakeExecutionContext({ handler: handler('me'), controller: Routes }),
      ),
    );

    expect(context.principal).toEqual(principal);
  });

  it('refuses a route that needs a principal when there is none', async () => {
    await expect(
      guardWith(new DenyAllPrincipalResolver()).canActivate(
        fakeExecutionContext({ handler: handler('me'), controller: Routes }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses an undeclared route as well, because silence is not permission', async () => {
    await expect(
      guardWith(new DenyAllPrincipalResolver()).canActivate(fakeExecutionContext()),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('leaves a non-HTTP context to the gateway that owns it', async () => {
    await expect(
      guardWith(new DenyAllPrincipalResolver()).canActivate(
        fakeExecutionContext({ type: 'ws', handler: handler('me'), controller: Routes }),
      ),
    ).resolves.toBe(true);
  });
});
