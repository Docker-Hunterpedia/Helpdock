import { describe, expect, it } from 'vitest';
import {
  auditStamp,
  hasFilters,
  initialsOf,
  NO_FILTERS,
  queryOf,
  userAgentSummary,
  utcOffsetLabel,
} from './audit-format.js';

describe('queryOf', () => {
  it('sends only the filters that are set', () => {
    expect(queryOf(NO_FILTERS, null)).toEqual({});
    expect(
      queryOf({ ...NO_FILTERS, actor: ' Lina ', action: 'ticket.*', brand: 'install' }, 'c1'),
    ).toEqual({ actor: 'Lina', action: 'ticket.*', brand: 'install', cursor: 'c1' });
  });

  it('turns a day range into the whole of both days, inclusive', () => {
    const query = queryOf({ ...NO_FILTERS, from: '2026-09-20', to: '2026-09-27' }, null);

    expect(new Date(query.from ?? '').getDate()).toBe(20);
    expect(new Date(query.from ?? '').getHours()).toBe(0);
    const to = new Date(query.to ?? '');
    expect([to.getDate(), to.getHours(), to.getMinutes(), to.getSeconds()]).toEqual([
      27, 23, 59, 59,
    ]);
  });

  it('ignores a date that is not one', () => {
    expect(queryOf({ ...NO_FILTERS, from: '27/09/2026' }, null)).toEqual({});
  });
});

describe('hasFilters', () => {
  it('is true once anything is set', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, targetType: 'macro' })).toBe(true);
  });
});

describe('auditStamp', () => {
  it('prints local time with Latin digits', () => {
    const at = new Date(2026, 8, 27, 14, 22, 8);

    expect(auditStamp(at.toISOString())).toBe('2026-09-27 14:22:08');
  });
});

describe('utcOffsetLabel', () => {
  const at = (offsetMinutes: number): Date =>
    ({ getTimezoneOffset: () => offsetMinutes }) as unknown as Date;

  it.each([
    [0, 'UTC'],
    [-180, 'UTC+3'],
    [240, 'UTC-4'],
    [-330, 'UTC+5:30'],
  ])('reads an offset of %s minutes as %s', (offset, label) => {
    expect(utcOffsetLabel(at(offset))).toBe(label);
  });
});

describe('userAgentSummary', () => {
  it.each([
    [
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Firefox',
      'Ubuntu',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0',
      'Edge',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      'Safari',
      'macOS',
    ],
  ])('reads %s', (agent, browser, system) => {
    expect(userAgentSummary(agent)).toEqual({ browser, system });
  });

  it('says nothing about what it cannot read', () => {
    expect(userAgentSummary(null)).toBeNull();
    expect(userAgentSummary('curl/8.9.1')).toBeNull();
  });
});

describe('initialsOf', () => {
  it('takes two letters', () => {
    expect(initialsOf('Lina Haddad')).toBe('LH');
    expect(initialsOf('omar')).toBe('O');
  });
});
