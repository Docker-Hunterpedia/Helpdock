import type { AccountPortal } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  accountDraftChanged,
  accountDraftOf,
  accountRequestOf,
  relativeWhen,
  sharesHistory,
} from './portal-format.js';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('relativeWhen', () => {
  it('reads in the interface language with Latin digits', () => {
    expect(relativeWhen(ago(2 * DAY), NOW, 'en')).toBe('2 days ago');
    expect(relativeWhen(ago(5 * DAY), NOW, 'ar')).toMatch(/5/);
    expect(relativeWhen(ago(5 * DAY), NOW, 'ar')).not.toMatch(/[٠-٩]/);
    expect(relativeWhen(ago(2 * HOUR), NOW, 'en')).toBe('2 hours ago');
  });

  it('says today for the last few minutes, and picks the largest unit that fits', () => {
    expect(relativeWhen(ago(10_000), NOW, 'en')).toBe('today');
    expect(relativeWhen(ago(40 * DAY), NOW, 'en')).toBe('last month');
  });
});

const portal = (overrides: Partial<AccountPortal> = {}): AccountPortal => ({
  visibility: 'own',
  members: [
    { contactId: 'a', name: 'A', email: null, role: 'manager', lastSignInAt: null },
    { contactId: 'b', name: 'B', email: null, role: 'member', lastSignInAt: null },
  ],
  ...overrides,
});

describe('the account draft', () => {
  it('starts as stored, with the managers ticked', () => {
    expect(accountDraftOf(portal())).toEqual({ visibility: 'own', managerIds: ['a'] });
    expect(accountDraftChanged(accountDraftOf(portal()), portal())).toBe(false);
  });

  it('sees a new setting and a changed set of managers, in any order', () => {
    expect(accountDraftChanged({ visibility: 'all', managerIds: ['a'] }, portal())).toBe(true);
    expect(accountDraftChanged({ visibility: 'own', managerIds: ['a', 'b'] }, portal())).toBe(true);
    expect(accountDraftChanged({ visibility: 'own', managerIds: [] }, portal())).toBe(true);
    expect(accountDraftChanged({ visibility: 'own', managerIds: ['a'] }, portal())).toBe(false);
  });

  it('warns only for the two settings that share history', () => {
    expect(sharesHistory('own')).toBe(false);
    expect(sharesHistory('managers')).toBe(true);
    expect(sharesHistory('all')).toBe(true);
  });

  it('builds the request, keeping the ticked managers whatever the setting', () => {
    expect(accountRequestOf({ visibility: 'own', managerIds: ['a'] })).toEqual({
      visibility: 'own',
      managerContactIds: ['a'],
    });
  });
});
