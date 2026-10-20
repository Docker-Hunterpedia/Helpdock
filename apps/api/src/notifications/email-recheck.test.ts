import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMAIL_PREFERENCES,
  type EmailPreferences,
  type RowFacts,
  verdictFor,
} from './email-recheck.js';
import type { StaffFacts } from './recipients.js';

const NOW = new Date('2026-10-20T09:00:00.000Z');
const SUPPORT = 'support';

const lina: StaffFacts = {
  userId: 'lina',
  name: 'Lina Haddad',
  email: 'lina@helpdock.test',
  departmentIds: [SUPPORT],
  deactivated: false,
};

const unread: RowFacts = { readAt: null, email: true, ticketDepartmentId: SUPPORT };

const verdict = ({
  row = unread,
  recipient = lina,
  preferences = DEFAULT_EMAIL_PREFERENCES,
}: {
  row?: RowFacts;
  /** Null for someone who no longer holds a role in the brand. */
  recipient?: StaffFacts | null;
  preferences?: EmailPreferences;
} = {}) => verdictFor({ row, recipient: recipient ?? undefined, preferences, now: NOW });

describe('the send-time re-check (DOMAIN-RULES §20)', () => {
  it('sends an unread row about a ticket the person may still see', () => {
    expect(verdict()).toBe('send');
  });

  it('skips a row read in the app before its email went', () => {
    expect(verdict({ row: { ...unread, readAt: new Date('2026-10-20T08:59:00.000Z') } })).toBe(
      'skipped_read',
    );
  });

  it.each<[string, Partial<Parameters<typeof verdict>[0]>]>([
    ['the ticket is gone', { row: { ...unread, ticketDepartmentId: null } }],
    [
      'it moved to a department they cannot see',
      { row: { ...unread, ticketDepartmentId: 'billing' } },
    ],
    ['they no longer hold a role in the brand', { recipient: null }],
    ['they were deactivated', { recipient: { ...lina, deactivated: true } }],
  ])('skips for scope when %s', (_name, options) => {
    expect(verdict(options)).toBe('skipped_scope');
  });

  it('puts scope before everything else, a read row included', () => {
    expect(verdict({ row: { readAt: NOW, email: true, ticketDepartmentId: 'billing' } })).toBe(
      'skipped_scope',
    );
  });

  it.each<[string, Partial<Parameters<typeof verdict>[0]>]>([
    ['the row was made without email', { row: { ...unread, email: false } }],
    ['the schedule is now Off', { preferences: { ...DEFAULT_EMAIL_PREFERENCES, schedule: 'off' } }],
    [
      'they unsubscribed',
      { preferences: { ...DEFAULT_EMAIL_PREFERENCES, unsubscribedAt: new Date('2026-10-01') } },
    ],
  ])('skips as off when %s', (_name, options) => {
    expect(verdict(options)).toBe('skipped_off');
  });

  it('skips a row while they are paused, and sends once the pause has ended', () => {
    const paused = (until: Date): EmailPreferences => ({
      ...DEFAULT_EMAIL_PREFERENCES,
      pausedUntil: until,
    });

    expect(verdict({ preferences: paused(new Date('2026-10-20T10:00:00.000Z')) })).toBe(
      'skipped_paused',
    );
    expect(verdict({ preferences: paused(NOW) })).toBe('send');
  });
});
