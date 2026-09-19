import { INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import type { Principal } from './principal.js';
import { resolveTargetBrand } from './target-brand.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const inBrands = (...brandIds: string[]): Principal => ({
  type: 'staff',
  id: USER,
  brands: Object.fromEntries(
    brandIds.map((brandId) => [brandId, { role: 'admin' as const, departmentIds: 'all' as const }]),
  ),
  installAdmin: false,
});

describe('resolveTargetBrand', () => {
  it('prefers the path parameter over everything else', () => {
    expect(
      resolveTargetBrand({
        principal: inBrands(BRAND_A),
        params: { brandId: BRAND_B },
        hostBrandId: BRAND_A,
      }),
    ).toEqual({ ok: true, brandId: BRAND_B });
  });

  it('refuses a path parameter that is not a uuid before it reaches a session setting', () => {
    expect(
      resolveTargetBrand({
        principal: inBrands(BRAND_A),
        params: { brandId: "') OR true--" },
        hostBrandId: null,
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses the install sentinel wherever a brand id could come from', () => {
    // It is a valid UUID and the scope that reads install-wide settings and
    // audit rows. A brand-scoped route must never be able to name it.
    expect(
      resolveTargetBrand({
        principal: inBrands(INSTALL_SCOPE_BRAND_ID),
        params: { brandId: INSTALL_SCOPE_BRAND_ID },
        hostBrandId: null,
      }),
    ).toEqual({ ok: false, reason: 'invalid' });

    expect(
      resolveTargetBrand({
        principal: inBrands(BRAND_A),
        params: {},
        hostBrandId: INSTALL_SCOPE_BRAND_ID,
      }),
    ).toEqual({ ok: false, reason: 'invalid' });

    expect(
      resolveTargetBrand({
        principal: inBrands(INSTALL_SCOPE_BRAND_ID),
        params: {},
        hostBrandId: null,
      }),
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses a path parameter that is not a string', () => {
    expect(
      resolveTargetBrand({
        principal: inBrands(BRAND_A),
        params: { brandId: ['a', 'b'] },
        hostBrandId: null,
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('falls back to the brand the host named', () => {
    expect(
      resolveTargetBrand({
        principal: inBrands(BRAND_A, BRAND_B),
        params: {},
        hostBrandId: BRAND_B,
      }),
    ).toEqual({ ok: true, brandId: BRAND_B });
  });

  it("falls back to the principal's only brand", () => {
    expect(
      resolveTargetBrand({ principal: inBrands(BRAND_A), params: undefined, hostBrandId: null }),
    ).toEqual({ ok: true, brandId: BRAND_A });
  });

  it('refuses to guess when the principal holds several brands', () => {
    expect(
      resolveTargetBrand({
        principal: inBrands(BRAND_A, BRAND_B),
        params: {},
        hostBrandId: null,
      }),
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses when the principal holds none', () => {
    expect(resolveTargetBrand({ principal: inBrands(), params: {}, hostBrandId: null })).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('uses the single brand a visitor or an api key belongs to', () => {
    const visitor: Principal = {
      type: 'visitor',
      id: USER,
      brandId: BRAND_A,
      conversationIds: [],
    };

    expect(resolveTargetBrand({ principal: visitor, params: {}, hostBrandId: null })).toEqual({
      ok: true,
      brandId: BRAND_A,
    });
  });
});
