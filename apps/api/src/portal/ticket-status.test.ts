import { describe, expect, it } from 'vitest';
import { customerStatusOf, type StatusFacts } from './ticket-status.js';

const status = (
  systemState: StatusFacts['systemState'],
  awaitingCustomer = false,
): StatusFacts => ({ systemState, awaitingCustomer });

describe('customerStatusOf', () => {
  it.each([
    ['an open status', status('open'), false, false, 'open'],
    ['an escalated status', status('escalated'), false, false, 'waiting_us'],
    ['an on-hold status', status('on_hold'), false, false, 'waiting_us'],
    [
      'an on-hold status waiting for the customer',
      status('on_hold', true),
      false,
      false,
      'waiting_you',
    ],
    [
      'an open status flagged awaiting the customer',
      status('open', true),
      false,
      false,
      'waiting_you',
    ],
    ['a closed status', status('closed'), true, false, 'solved'],
    ['a closed status whose closed_at is somehow unset', status('closed'), false, false, 'solved'],
    ['an open status with closed_at set', status('open'), true, false, 'solved'],
    [
      'a closed status that also awaits the customer',
      status('closed', true),
      true,
      false,
      'solved',
    ],
  ] as const)('reads %s as %s', (_name, facts, closed, snoozed, expected) => {
    expect(customerStatusOf({ status: facts, closed, snoozed })).toBe(expected);
  });

  it('reads a snoozed ticket as Waiting for us, whichever open status it will wake into', () => {
    expect(customerStatusOf({ status: status('open'), closed: false, snoozed: true })).toBe(
      'waiting_us',
    );
  });

  it('lets the customer be waited on even while snoozed', () => {
    expect(
      customerStatusOf({ status: status('on_hold', true), closed: false, snoozed: true }),
    ).toBe('waiting_you');
  });

  it('reads a status that could not be found as Waiting for us rather than failing', () => {
    expect(customerStatusOf({ status: undefined, closed: false, snoozed: false })).toBe(
      'waiting_us',
    );
    expect(customerStatusOf({ status: undefined, closed: true, snoozed: false })).toBe('solved');
  });
});
