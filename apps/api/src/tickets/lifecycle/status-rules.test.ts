import type { TicketStatus as TicketStatusRow } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { statusDeleteRefusal, statusEditRefusal } from './status-rules.js';

/**
 * Which edits a status row accepts, and which deletes it refuses
 * (DOMAIN-RULES §2.1, §2.2, and `packages/db/src/ticket-statuses.ts` on why the
 * seeded rows' flags are fixed).
 */

const status = (overrides: Partial<TicketStatusRow> = {}): TicketStatusRow =>
  ({
    id: '0199f4b2-0000-7000-8000-000000000001',
    brandId: '0199f4b2-0000-7000-8000-0000000000b1',
    name: 'Waiting on supplier',
    nameAr: null,
    systemState: 'on_hold',
    pausesSla: true,
    awaitingCustomer: false,
    isDefault: false,
    isSystem: false,
    excludedFromReports: false,
    sortOrder: 70,
    color: 'warning',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as TicketStatusRow;

describe('statusEditRefusal', () => {
  it('lets a custom status change anything', () => {
    expect(
      statusEditRefusal(status(), {
        name: 'Waiting on vendor',
        systemState: 'escalated',
        pausesSla: false,
        awaitingCustomer: true,
        color: 'danger',
      }),
    ).toBeNull();
  });

  it('lets a system status be renamed and recoloured', () => {
    expect(
      statusEditRefusal(status({ isSystem: true }), { name: 'On hold', color: 'info' }),
    ).toBeNull();
  });

  it.each(['systemState', 'pausesSla', 'awaitingCustomer'] as const)(
    'refuses %s on a system status, because code finds the row by it',
    (field) => {
      const request =
        field === 'systemState' ? { systemState: 'open' as const } : { [field]: true };

      expect(statusEditRefusal(status({ isSystem: true }), request)).toBe('status-state-fixed');
    },
  );

  it('refuses making a non-open status the default', () => {
    expect(statusEditRefusal(status({ systemState: 'closed' }), { isDefault: true })).toBe(
      'default-must-be-open',
    );
  });

  it('allows making an open status the default', () => {
    expect(statusEditRefusal(status({ systemState: 'open' }), { isDefault: true })).toBeNull();
  });

  it('reads the requested state, not the stored one, when both move at once', () => {
    expect(
      statusEditRefusal(status({ systemState: 'closed' }), {
        systemState: 'open',
        isDefault: true,
      }),
    ).toBeNull();
  });

  it('refuses moving the current default off open', () => {
    expect(
      statusEditRefusal(status({ isDefault: true, systemState: 'open' }), {
        systemState: 'closed',
      }),
    ).toBe('default-must-be-open');
  });

  it('is checked before the default rule, so a system row says which rule refused', () => {
    expect(
      statusEditRefusal(status({ isSystem: true, isDefault: true, systemState: 'open' }), {
        systemState: 'closed',
      }),
    ).toBe('status-state-fixed');
  });
});

describe('statusDeleteRefusal', () => {
  it('allows deleting a custom status', () => {
    expect(statusDeleteRefusal(status())).toBeNull();
  });

  it('refuses a seeded status', () => {
    expect(statusDeleteRefusal(status({ isSystem: true }))).toBe('status-is-system');
  });

  it('refuses the default, so another has to take the role first', () => {
    expect(statusDeleteRefusal(status({ isDefault: true, systemState: 'open' }))).toBe(
      'status-is-default',
    );
  });
});
