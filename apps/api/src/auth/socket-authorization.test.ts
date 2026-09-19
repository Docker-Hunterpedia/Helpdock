import { describe, expect, it } from 'vitest';
import type { Principal } from './principal.js';
import type { RouteDeclaration } from './route-declaration.js';
import { authorizeSocketMessage } from './socket-authorization.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const staff = (installAdmin = false): Principal => ({
  type: 'staff',
  id: USER,
  brands: { [BRAND_A]: { role: 'agent', departmentIds: 'all' } },
  installAdmin,
});

const requires = (permission: 'brand:read' | 'install:admin'): RouteDeclaration => ({
  kind: 'permission',
  permission,
});

describe('authorizeSocketMessage', () => {
  it('refuses an event that declares nothing: silence never means allow', () => {
    expect(
      authorizeSocketMessage({ declaration: undefined, principal: staff(), data: {} }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('refuses an authenticated event on a socket with no principal', () => {
    expect(
      authorizeSocketMessage({ declaration: { kind: 'authenticated' }, principal: null, data: {} }),
    ).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
  });

  it('lets a declared public event through, since the handshake already refused strangers', () => {
    expect(
      authorizeSocketMessage({ declaration: { kind: 'public' }, principal: null, data: {} }),
    ).toEqual({ ok: true });
  });

  it('checks the permission in the brand the message names', () => {
    expect(
      authorizeSocketMessage({
        declaration: requires('brand:read'),
        principal: staff(),
        data: { brandId: BRAND_A },
      }),
    ).toEqual({ ok: true });

    expect(
      authorizeSocketMessage({
        declaration: requires('brand:read'),
        principal: staff(),
        data: { brandId: BRAND_B },
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it.each([
    ['no brand at all', {}],
    ['a brand that is not a uuid', { brandId: 'brand-a' }],
    ['no object at all', 'brand-a'],
  ])('refuses a brand-scoped event with %s', (_name, data) => {
    expect(
      authorizeSocketMessage({ declaration: requires('brand:read'), principal: staff(), data }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
  });

  it('keeps install:admin out of the brand matrix, exactly as HTTP does', () => {
    expect(
      authorizeSocketMessage({
        declaration: requires('install:admin'),
        principal: staff(),
        data: { brandId: BRAND_A },
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    expect(
      authorizeSocketMessage({
        declaration: requires('install:admin'),
        principal: staff(true),
        data: {},
      }),
    ).toEqual({ ok: true });
  });
});
