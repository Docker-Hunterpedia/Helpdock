import { brandRoom, departmentRoom, ticketRoom } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { BrandMembership } from '../auth/principal.js';
import type { RoomScopeReader } from './room-reader.js';
import { authorizeRoom } from './rooms.js';
import type { StaffPrincipal } from './socket.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const DEPARTMENT_1 = '01937f5e-7e53-7000-8000-000000000011';
const DEPARTMENT_2 = '01937f5e-7e53-7000-8000-000000000012';
const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const staff = (brands: Record<string, BrandMembership>): StaffPrincipal => ({
  type: 'staff',
  id: USER,
  brands,
  installAdmin: false,
});

/**
 * What the database would answer. The real reader asks row-level security, so
 * `false` here stands for both "no such row" and "not in your scope" — which is
 * the point: the two are one answer.
 */
const reader = (answers: Partial<Record<'ticket' | 'department', boolean>> = {}) =>
  ({
    ticketInScope: vi.fn().mockResolvedValue(answers.ticket ?? false),
    departmentInScope: vi.fn().mockResolvedValue(answers.department ?? false),
  }) satisfies RoomScopeReader & Record<string, unknown>;

describe('authorizeRoom', () => {
  describe('brand rooms', () => {
    it.each(['admin', 'team_leader', 'agent', 'viewer'] as const)(
      'lets a %s into the brand they hold a role in',
      async (role) => {
        await expect(
          authorizeRoom({
            principal: staff({ [BRAND_A]: { role, departmentIds: 'all' } }),
            brandId: BRAND_A,
            room: brandRoom(BRAND_A),
            reader: reader(),
          }),
        ).resolves.toEqual({ ok: true });
      },
    );

    it('refuses a brand room that is not the brand the message named', async () => {
      // Without this, a member of A could listen to B by naming A as the
      // permission target and B as the room.
      await expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          brandId: BRAND_A,
          room: brandRoom(BRAND_B),
          reader: reader(),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });

  describe('department rooms', () => {
    it('lets an agent into a department they are in, without asking the database', async () => {
      const scope = reader();

      await expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] } }),
          brandId: BRAND_A,
          room: departmentRoom(DEPARTMENT_1),
          reader: scope,
        }),
      ).resolves.toEqual({ ok: true });
      // An explicit list is itself per-brand, so membership proves both halves.
      expect(scope.departmentInScope).not.toHaveBeenCalled();
    });

    it('refuses an agent a department outside their scope (DOMAIN-RULES §1.2)', async () => {
      await expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] } }),
          brandId: BRAND_A,
          room: departmentRoom(DEPARTMENT_2),
          reader: reader(),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });

    it('lets an unrestricted scope in once the department is proved to be that brand’s', async () => {
      const scope = reader({ department: true });

      await expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          brandId: BRAND_A,
          room: departmentRoom(DEPARTMENT_2),
          reader: scope,
        }),
      ).resolves.toEqual({ ok: true });
      expect(scope.departmentInScope).toHaveBeenCalledWith({
        brandId: BRAND_A,
        departmentIds: 'all',
        principalId: USER,
        departmentId: DEPARTMENT_2,
      });
    });

    it('refuses an unrestricted scope a department of another brand', async () => {
      // `all` means "every department *of that brand*", and a room name carries
      // no brand. The reader answers through the brand's own transaction, so a
      // department of another brand is simply not there.
      await expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          brandId: BRAND_A,
          room: departmentRoom(DEPARTMENT_2),
          reader: reader({ department: false }),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });

    it('will not let one brand’s scope reach another brand’s department', async () => {
      await expect(
        authorizeRoom({
          principal: staff({
            [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] },
            [BRAND_B]: { role: 'admin', departmentIds: 'all' },
          }),
          brandId: BRAND_B,
          room: departmentRoom(DEPARTMENT_1),
          reader: reader({ department: false }),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });

  describe('ticket rooms', () => {
    it('lets a principal into a ticket the policies show them', async () => {
      const scope = reader({ ticket: true });

      await expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] } }),
          brandId: BRAND_A,
          room: ticketRoom(TICKET),
          reader: scope,
        }),
      ).resolves.toEqual({ ok: true });
      expect(scope.ticketInScope).toHaveBeenCalledWith({
        brandId: BRAND_A,
        departmentIds: [DEPARTMENT_1],
        principalId: USER,
        ticketId: TICKET,
      });
    });

    it('refuses a ticket the policies hide, whatever the reason', async () => {
      await expect(
        authorizeRoom({
          principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1] } }),
          brandId: BRAND_A,
          room: ticketRoom(TICKET),
          reader: reader({ ticket: false }),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });

  it('refuses a room name that is not one', async () => {
    await expect(
      authorizeRoom({
        principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        brandId: BRAND_A,
        room: 'conversation:1',
        reader: reader(),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
  });

  it('refuses a brand the principal holds no role in at all', async () => {
    await expect(
      authorizeRoom({
        principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
        brandId: BRAND_B,
        room: brandRoom(BRAND_B),
        reader: reader(),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});
