import { describe, expect, it } from 'vitest';
import type { DbTransaction } from './client.js';
import {
  BUILT_IN_TICKET_STATUSES,
  DEFAULT_TICKET_STATUS_KEY,
  seedBrandStatuses,
} from './ticket-statuses.js';

/**
 * The seeded statuses are a contract, not a preference: the reopen path needs
 * the default open status, merge needs Merged and spam needs Spam
 * (DOMAIN-RULES §2.2, §2.4). These assertions fail when one is renamed out of
 * existence or when two of them claim to be the default.
 */
describe('the built-in statuses', () => {
  it('covers the two DOMAIN-RULES §2.1 names a brand always has', () => {
    const names = BUILT_IN_TICKET_STATUSES.map((status) => status.name);

    expect(names).toContain('Awaiting customer');
    expect(names).toContain('Spam');
  });

  it('includes the Merged status the secondary of a merge closes into (§2.4)', () => {
    const merged = BUILT_IN_TICKET_STATUSES.find((status) => status.key === 'merged');

    expect(merged).toMatchObject({ systemState: 'closed' });
  });

  it('covers all four system states, so a brand can work a ticket without adding one', () => {
    expect(new Set(BUILT_IN_TICKET_STATUSES.map((status) => status.systemState))).toEqual(
      new Set(['open', 'on_hold', 'escalated', 'closed']),
    );
  });

  it('has exactly one default, which is the one a new ticket lands in', () => {
    const defaults = BUILT_IN_TICKET_STATUSES.filter((status) => status.isDefault);

    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.key).toBe(DEFAULT_TICKET_STATUS_KEY);
    expect(defaults[0]?.systemState).toBe('open');
  });

  it('pauses the SLA exactly where §2.1 says it does', () => {
    const pausing = BUILT_IN_TICKET_STATUSES.filter((status) => status.pausesSla);

    expect(pausing.map((status) => status.key)).toEqual(['awaiting_customer']);
  });

  it('flags awaiting_customer only on Awaiting customer', () => {
    const awaiting = BUILT_IN_TICKET_STATUSES.filter((status) => status.awaitingCustomer);

    expect(awaiting.map((status) => status.key)).toEqual(['awaiting_customer']);
  });

  it('gives every status an Arabic label, because the brand may run in Arabic', () => {
    expect(BUILT_IN_TICKET_STATUSES.every((status) => status.nameAr.length > 0)).toBe(true);
  });

  it('names each status once, or the unique index would drop one silently', () => {
    const names = BUILT_IN_TICKET_STATUSES.map((status) => status.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('orders them for the picker, lowest first and without a tie', () => {
    const order = BUILT_IN_TICKET_STATUSES.map((status) => status.sortOrder);

    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('draws escalation in the one hue DESIGN §2.1 reserves for it', () => {
    const escalated = BUILT_IN_TICKET_STATUSES.filter(
      (status) => status.systemState === 'escalated',
    );

    expect(escalated.map((status) => status.color)).toEqual(['escalated']);
  });
});

describe('seedBrandStatuses', () => {
  const BRAND = '01937f5e-7e53-7000-8000-00000000000a';

  /** Records the insert without a database; the integration suite runs the real one. */
  const recordingTx = () => {
    const inserts: { values: unknown; conflict: unknown }[] = [];
    const tx = {
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoNothing: (conflict: unknown) => {
            inserts.push({ values, conflict });
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as DbTransaction;

    return { tx, inserts };
  };

  it('writes every built-in status for the brand, marked as a system one', async () => {
    const { tx, inserts } = recordingTx();

    await seedBrandStatuses(tx, BRAND);

    const values = inserts[0]?.values as { brandId: string; isSystem: boolean; name: string }[];
    expect(values).toHaveLength(BUILT_IN_TICKET_STATUSES.length);
    expect(values.every((status) => status.brandId === BRAND && status.isSystem)).toBe(true);
  });

  it('does not write the `key` that only code uses', async () => {
    const { tx, inserts } = recordingTx();

    await seedBrandStatuses(tx, BRAND);

    expect(inserts[0]?.values).not.toHaveProperty('0.key');
  });

  it('is idempotent on (brand, name), so a retried brand creation adds nothing', async () => {
    const { tx, inserts } = recordingTx();

    await seedBrandStatuses(tx, BRAND);

    expect(inserts[0]?.conflict).toEqual({
      target: [expect.anything(), expect.anything()],
    });
  });
});
