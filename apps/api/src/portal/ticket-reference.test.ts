import { describe, expect, it } from 'vitest';
import { formatTicketReference, parseTicketReference } from './ticket-reference.js';

describe('ticket references', () => {
  it('formats the prefix and number the way an email prints them', () => {
    expect(formatTicketReference('HD', 1042)).toBe('HD-1042');
  });

  it.each([
    ['HD-1042', { prefix: 'HD', number: 1042 }],
    ['hd-1042', { prefix: 'HD', number: 1042 }],
    ['  GLBX-7  ', { prefix: 'GLBX', number: 7 }],
    ['A1-000012', { prefix: 'A1', number: 12 }],
  ])('parses %s', (value, expected) => {
    expect(parseTicketReference(value)).toEqual(expected);
  });

  it.each([
    '',
    'HD',
    'HD-',
    '-1042',
    'H-1042',
    'TOOLONG-1',
    'HD-0',
    'HD-12a',
    'HD--1',
    'HD-1042-1',
    'HD_1042',
    'HD-9999999999999',
    'ÄÖ-12',
    'HD-1; drop table tickets',
    '../etc',
  ])('refuses %j', (value) => {
    expect(parseTicketReference(value)).toBeNull();
  });
});
