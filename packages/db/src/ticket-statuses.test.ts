import { describe, expect, it } from 'vitest';
import { BUILT_IN_TICKET_STATUSES, DEFAULT_TICKET_STATUS_KEY } from './ticket-statuses.js';

/**
 * The seeded statuses are a contract, not a preference: the reopen path needs
 * the default open status, merge needs Merged and spam needs Spam
 * (DOMAIN-RULES §2.2, §2.4). These assertions fail when one is renamed out of
 * existence or when two of them claim to be the default.
 *
 * That `seedBrandStatuses` actually writes them, once, is proved against a real
 * Postgres in `apps/api/src/tickets/tickets.integration.test.ts`; faking
 * Drizzle's builder here would assert the shape of a fluent call and nothing
 * about persistence.
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

  it('keys Spam, and only Spam, as the status "Mark as spam" moves to (M1-11)', () => {
    // `is_spam` is generated from `system_key = 'spam'`, so the key is the flag.
    const spam = BUILT_IN_TICKET_STATUSES.filter((status) => status.key === 'spam');

    expect(spam.map((status) => status.key)).toEqual(['spam']);
    expect(spam[0]).toMatchObject({ systemState: 'closed', excludedFromReports: true });
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
