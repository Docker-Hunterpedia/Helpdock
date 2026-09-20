import { REOPEN_WITHIN_DAYS_DEFAULT } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { decideReopen } from './reopen-policy.js';

/**
 * DOMAIN-RULES §2.3. The three policy values, and the boundary the sentence
 * "less than N days ago" puts on one side rather than the other.
 */

const CLOSED_AT = new Date('2026-09-01T12:00:00.000Z');
const daysAfter = (days: number): Date =>
  new Date(CLOSED_AT.getTime() + days * 24 * 60 * 60 * 1000);

describe('decideReopen', () => {
  it('always reopens under `always`, however old the ticket is', () => {
    expect(
      decideReopen({ policy: { kind: 'always' }, closedAt: CLOSED_AT, now: daysAfter(3650) }),
    ).toEqual({ kind: 'reopen' });
  });

  it('never reopens under `never`, however fresh the ticket is', () => {
    expect(
      decideReopen({ policy: { kind: 'never' }, closedAt: CLOSED_AT, now: daysAfter(0) }),
    ).toEqual({ kind: 'continue' });
  });

  describe('within_days, at the default of seven', () => {
    const policy = { kind: 'within_days', days: REOPEN_WITHIN_DAYS_DEFAULT } as const;

    it('reopens a ticket closed a moment ago', () => {
      expect(decideReopen({ policy, closedAt: CLOSED_AT, now: daysAfter(0) })).toEqual({
        kind: 'reopen',
      });
    });

    it('reopens on the last day inside the window', () => {
      expect(decideReopen({ policy, closedAt: CLOSED_AT, now: daysAfter(6.99) })).toEqual({
        kind: 'reopen',
      });
    });

    // The boundary, named in both directions so nobody has to re-derive which
    // side "less than N days ago" puts it on.
    it('continues in a new ticket at exactly seven days', () => {
      expect(decideReopen({ policy, closedAt: CLOSED_AT, now: daysAfter(7) })).toEqual({
        kind: 'continue',
      });
    });

    it('continues in a new ticket past the window', () => {
      expect(decideReopen({ policy, closedAt: CLOSED_AT, now: daysAfter(7.01) })).toEqual({
        kind: 'continue',
      });
    });

    it('treats a closed_at in the future as no time at all having passed', () => {
      expect(decideReopen({ policy, closedAt: CLOSED_AT, now: daysAfter(-1) })).toEqual({
        kind: 'reopen',
      });
    });

    it('reopens rather than splitting a thread when closed_at is missing', () => {
      expect(decideReopen({ policy, closedAt: null, now: daysAfter(3650) })).toEqual({
        kind: 'reopen',
      });
    });
  });

  it('honours a one-day window at its own boundary', () => {
    const policy = { kind: 'within_days', days: 1 } as const;

    expect(decideReopen({ policy, closedAt: CLOSED_AT, now: daysAfter(0.5) })).toEqual({
      kind: 'reopen',
    });
    expect(decideReopen({ policy, closedAt: CLOSED_AT, now: daysAfter(1) })).toEqual({
      kind: 'continue',
    });
  });
});
