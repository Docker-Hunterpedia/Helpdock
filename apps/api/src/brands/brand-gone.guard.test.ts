import type { Db } from '@helpdock/db';
import { type ExecutionContext, GoneException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ROUTE_DECLARATION, type RouteDeclaration } from '../auth/route-declaration.js';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { BrandAvailability, type BrandAvailabilityState } from './brand-availability.js';
import { BrandGoneGuard, publicBrandOf } from './brand-gone.guard.js';

const GONE = '01924f00-0000-7000-8000-0000000000aa';
const LIVE = '01924f00-0000-7000-8000-0000000000bb';

describe('publicBrandOf', () => {
  it('reads the path parameter first', () => {
    expect(publicBrandOf({ params: { brandId: GONE } }, LIVE)).toBe(GONE);
  });

  it('falls back to the brand the host named', () => {
    expect(publicBrandOf({ params: {}, url: '/en' }, LIVE)).toBe(LIVE);
  });

  it('reads the help center fallback path when nothing else names a brand', () => {
    expect(publicBrandOf({ url: `/hc/${GONE}/en/articles/refunds` }, null)).toBe(GONE);
    expect(publicBrandOf({ url: `/hc/${GONE}?lang=ar` }, null)).toBe(GONE);
  });

  it('names no brand for a route that is about none', () => {
    expect(publicBrandOf({ url: '/widget.js' }, null)).toBeNull();
    expect(publicBrandOf({ url: '/hc/not-a-brand/en' }, null)).toBeNull();
  });
});

class FixedAvailability extends BrandAvailability {
  constructor(readonly states: Record<string, BrandAvailabilityState>) {
    super({} as Db);
  }

  override async stateOf(brandId: string): Promise<BrandAvailabilityState> {
    return this.states[brandId] ?? 'missing';
  }
}

const contextFor = (
  declaration: RouteDeclaration,
  params: Record<string, unknown>,
  type: 'http' | 'ws' = 'http',
): ExecutionContext => {
  const handler = () => undefined;
  Reflect.defineMetadata(ROUTE_DECLARATION, declaration, handler);

  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ params, url: '/api/widget/x/config' }) }),
  } as unknown as ExecutionContext;
};

const run = (guard: BrandGoneGuard, context: ExecutionContext) =>
  runInRequestContext(new RequestContext({ requestId: 'r', method: 'GET', path: '/' }), () =>
    guard.canActivate(context),
  );

describe('BrandGoneGuard', () => {
  const guard = new BrandGoneGuard(
    new Reflector(),
    new FixedAvailability({ [GONE]: 'gone', [LIVE]: 'active' }),
  );

  it('answers 410 on a public route of a brand being deleted', async () => {
    await expect(run(guard, contextFor({ kind: 'public' }, { brandId: GONE }))).rejects.toThrow(
      GoneException,
    );
  });

  it('lets a public route of a live brand through', async () => {
    await expect(run(guard, contextFor({ kind: 'public' }, { brandId: LIVE }))).resolves.toBe(true);
  });

  it('leaves staff routes and sockets to their own checks', async () => {
    await expect(
      run(guard, contextFor({ kind: 'permission', permission: 'ticket:read' }, { brandId: GONE })),
    ).resolves.toBe(true);
    await expect(run(guard, contextFor({ kind: 'public' }, { brandId: GONE }, 'ws'))).resolves.toBe(
      true,
    );
  });
});

describe('BrandAvailability', () => {
  const fakeDb = (statuses: string[]): { db: Db; reads: () => number } => {
    let reads = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const status = statuses[Math.min(reads, statuses.length - 1)];
              reads += 1;
              return status === undefined ? [] : [{ status }];
            },
          }),
        }),
      }),
    } as unknown as Db;
    return { db, reads: () => reads };
  };

  it('reads a deleting or deleted brand as gone, an active one as active', async () => {
    expect(await new BrandAvailability(fakeDb(['deleting']).db).stateOf(GONE)).toBe('gone');
    expect(await new BrandAvailability(fakeDb(['deleted']).db).stateOf(GONE)).toBe('gone');
    expect(await new BrandAvailability(fakeDb(['active']).db).stateOf(LIVE)).toBe('active');
    expect(await new BrandAvailability(fakeDb([]).db).stateOf(LIVE)).toBe('missing');
    expect(await new BrandAvailability(fakeDb(['active']).db).stateOf('not-a-uuid')).toBe(
      'missing',
    );
  });

  it('keeps an answer for a few seconds, then reads again', async () => {
    let now = 0;
    const { db, reads } = fakeDb(['active', 'deleting']);
    const availability = new BrandAvailability(db, () => now);

    expect(await availability.isGone(LIVE)).toBe(false);
    now = 4_000;
    expect(await availability.isGone(LIVE)).toBe(false);
    expect(reads()).toBe(1);
    now = 6_000;
    expect(await availability.isGone(LIVE)).toBe(true);
  });
});
