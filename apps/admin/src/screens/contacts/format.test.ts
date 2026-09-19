import type { ContactIdentity, ContactSummary } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  csatLabel,
  DASH,
  durationLabel,
  identityLabel,
  initialsOf,
  isAnonymousVisitor,
  pageRange,
  shortVisitorId,
} from './format.js';

const identity = (kind: ContactIdentity['kind'], value: string): ContactIdentity => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
  kind,
  value,
  verified: false,
  verifiedAt: null,
  source: 'agent',
});

const summary = (channels: ContactSummary['channels']): ContactSummary => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c1',
  name: 'Mona Khalil',
  account: null,
  primaryIdentity: null,
  channels,
  stats: {
    openTickets: 0,
    totalTickets: 0,
    csat: null,
    averageFirstReplySeconds: null,
    lastTicketAt: null,
  },
  anonymised: false,
  createdAt: '2026-09-19T09:00:00.000Z',
  updatedAt: '2026-09-19T09:00:00.000Z',
});

describe('shortVisitorId', () => {
  it('shortens a uuid to something a person can say out loud', () => {
    expect(shortVisitorId('0192c3f0-1a2b-7c3d-8e4f-7f3a000000c2')).toBe('0192…c2');
  });

  it('leaves an already short id alone', () => {
    expect(shortVisitorId('7f3ac2')).toBe('7f3ac2');
  });
});

describe('identityLabel', () => {
  it('prints an address as it is', () => {
    expect(identityLabel(identity('email', 'mona@example.com'))).toBe('mona@example.com');
  });

  it('shortens a visitor id, which nobody reads in full', () => {
    expect(identityLabel(identity('visitor', '0192c3f0-1a2b-7c3d-8e4f-7f3a000000c2'))).toBe(
      '0192…c2',
    );
  });

  it('is a dash when there is nothing to print', () => {
    expect(identityLabel(null)).toBe(DASH);
  });
});

describe('isAnonymousVisitor', () => {
  it('is true for somebody who has only ever been a visitor id', () => {
    expect(isAnonymousVisitor(summary(['visitor']))).toBe(true);
  });

  it('is false once they have given an address', () => {
    expect(isAnonymousVisitor(summary(['email', 'visitor']))).toBe(false);
  });

  it('is false for a contact with no identifier at all', () => {
    expect(isAnonymousVisitor(summary([]))).toBe(false);
  });
});

describe('initialsOf', () => {
  it.each([
    ['Mona Khalil', 'MK'],
    ['Mona', 'M'],
    ['  Mona   Amal Khalil ', 'MK'],
  ])('reduces %s to %s', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  it('works on Arabic names, which have no upper case to fall back on', () => {
    expect(initialsOf('سارة الحسن')).toBe('سا');
  });

  it('is empty for an empty name', () => {
    expect(initialsOf('   ')).toBe('');
  });
});

describe('csatLabel', () => {
  it('prints a percentage', () => {
    expect(csatLabel(92)).toBe('92%');
  });

  it('rounds rather than printing a decimal on a badge', () => {
    expect(csatLabel(91.4)).toBe('91%');
  });

  it('is a dash when nobody has rated them', () => {
    expect(csatLabel(null)).toBe(DASH);
  });
});

describe('durationLabel', () => {
  it.each([
    [30, '30s'],
    [90, '2m'],
    [2_700, '45m'],
    [8_100, '2h 15m'],
  ])('prints %s seconds as %s', (seconds, expected) => {
    expect(durationLabel(seconds)).toBe(expected);
  });

  it('is a dash when there is nothing to average', () => {
    expect(durationLabel(null)).toBe(DASH);
  });
});

describe('pageRange', () => {
  it('counts from one, the way the footer reads', () => {
    expect(pageRange(0, 50, 412)).toEqual({ from: 1, to: 50, total: 412 });
  });

  it('follows the cursor onto the next page', () => {
    expect(pageRange(50, 50, 412)).toEqual({ from: 51, to: 100, total: 412 });
  });

  it('says zero of zero rather than one of zero on an empty list', () => {
    expect(pageRange(0, 0, 0)).toEqual({ from: 0, to: 0, total: 0 });
  });
});
