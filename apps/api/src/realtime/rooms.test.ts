import { brandRoom, departmentRoom, ticketRoom } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { BrandMembership } from '../auth/principal.js';
import { authorizeRoom } from './rooms.js';
import type { StaffPrincipal } from './socket.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const DEPARTMENT_1 = '01937f5e-7e53-7000-8000-000000000011';
const DEPARTMENT_2 = '01937f5e-7e53-7000-8000-000000000012';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const staff = (brands: Record<string, BrandMembership>): StaffPrincipal => ({
  type: 'staff',
  id: USER,
  brands,
  installAdmin: false,
});

describe('authorizeRoom', () => {
  describe('brand rooms', () => {
    it.each(['admin', 'team_leader', 'agent', 'viewer'] as const)(
      'lets a %s into the brand they hold a role in',
      (role) => {
        expect(
          authorizeRoom({
            principal: staff({ [BRAND_A]: { role, departmentIds: 'all' } }),
            brandId: BRAND_A,
            room: brandRoom(BRAND_A),
          }),
        ).toEqual({ ok: true });
      },
    );

    it('refuses a brand room that is not the brand the message named', () => {
      // Without this, a member of A could listen to B by naming A as the
      // permission target and B as the room.
      expect(
        authorizeRoom({
          principal: staff({
            [BRAND_A]: { role: 'admin', departmentIds: 'all' },
          }),
          brandId: BRAND_A,
          room: brandRoom(BRAND_B),
        }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });

  describe('department rooms', () => {
    it('refuses an unrestricted scope, which nothing can check without a departments table', () => {
      // `all` means "every department *of that brand*", and a room name carries
      // no brand. Allowing it would let a member of any brand listen to any
      // department id in the install once M1 emits to these rooms.
      expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          brandId: BRAND_A,
          room: departmentRoom(DEPARTMENT_2),
        }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });

    it('lets an agent into a department they are in', () => {
      expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] } }),
          brandId: BRAND_A,
          room: departmentRoom(DEPARTMENT_1),
        }),
      ).toEqual({ ok: true });
    });

    it('refuses an agent a department outside their scope (DOMAIN-RULES §1.2)', () => {
      expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] } }),
          brandId: BRAND_A,
          room: departmentRoom(DEPARTMENT_2),
        }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });

    it('will not let one brand’s scope reach another brand’s department', () => {
      // Naming brand B, where the scope is unrestricted, must not open brand
      // A's departments — which is what an unchecked `all` would have done.
      expect(
        authorizeRoom({
          principal: staff({
            [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] },
            [BRAND_B]: { role: 'admin', departmentIds: 'all' },
          }),
          brandId: BRAND_B,
          room: departmentRoom(DEPARTMENT_1),
        }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });

  it('refuses ticket rooms until M1 can check them', () => {
    expect(
      authorizeRoom({
        principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        brandId: BRAND_A,
        room: ticketRoom(DEPARTMENT_1),
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('refuses a room name that is not one', () => {
    expect(
      authorizeRoom({
        principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        brandId: BRAND_A,
        room: 'conversation:1',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
  });

  it('refuses a brand the principal holds no role in at all', () => {
    expect(
      authorizeRoom({
        principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        brandId: BRAND_B,
        room: brandRoom(BRAND_B),
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});
