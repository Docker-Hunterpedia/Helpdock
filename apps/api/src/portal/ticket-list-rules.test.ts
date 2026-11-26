import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  likePattern,
  PAGE_SIZE,
  parseListQuery,
  parseSearch,
  SEARCH_MAX,
} from './ticket-list-rules.js';

const NUMBER = 1042;
const AT = new Date('2026-11-26T10:00:00.123Z');

describe('the ticket list query', () => {
  it('shows 20 rows to a page', () => {
    expect(PAGE_SIZE).toBe(20);
  });

  it('defaults to Mine and Open with no search and no cursor', () => {
    expect(parseListQuery({}, 'own')).toEqual({
      scope: 'mine',
      state: 'open',
      search: { kind: 'none' },
      cursor: null,
    });
  });

  it('honours scope=company only for a customer whose account lets them see it', () => {
    expect(parseListQuery({ scope: 'company' }, 'account').scope).toBe('company');
    expect(parseListQuery({ scope: 'company' }, 'own').scope).toBe('mine');
  });

  it('falls back to the defaults for any other scope or state', () => {
    const query = parseListQuery({ scope: 'everyone', state: 'all' }, 'account');
    expect(query.scope).toBe('mine');
    expect(query.state).toBe('open');
    expect(parseListQuery({ state: 'solved' }, 'own').state).toBe('solved');
  });
});

describe('the search', () => {
  it('is none for empty or blank input', () => {
    expect(parseSearch(undefined)).toEqual({ kind: 'none' });
    expect(parseSearch('   ')).toEqual({ kind: 'none' });
  });

  it('collapses whitespace, trims and caps the length', () => {
    const search = parseSearch(`  a   b ${'x'.repeat(500)}`);
    expect(search.kind === 'text' && search.text.length).toBe(SEARCH_MAX);
    expect(search.kind === 'text' && search.text.startsWith('a b x')).toBe(true);
  });

  it('also reads a reference or a bare number as an exact match', () => {
    expect(parseSearch('hd-1042')).toEqual({
      kind: 'text',
      text: 'hd-1042',
      reference: { prefix: 'HD', number: 1042 },
    });
    expect(parseSearch('#1042')).toEqual({
      kind: 'text',
      text: '#1042',
      reference: { number: 1042 },
    });
    expect(parseSearch('refund')).toEqual({ kind: 'text', text: 'refund', reference: null });
  });

  it('escapes LIKE wildcards so a search for 50% is not a pattern', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('the cursor', () => {
  it('carries the ticket number and the instant, and no internal id', () => {
    const raw = Buffer.from(
      encodeCursor({ updatedAt: AT, number: NUMBER }),
      'base64url',
    ).toString();
    expect(JSON.parse(raw)).toEqual({ u: AT.toISOString(), n: NUMBER });
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it.each([0, -1, 1.5, 2 ** 60])('refuses the number %s', (n) => {
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ u: AT.toISOString(), n })).toString('base64url')),
    ).toBeNull();
  });

  it('round-trips the last row', () => {
    expect(decodeCursor(encodeCursor({ updatedAt: AT, number: NUMBER }))).toEqual({
      updatedAt: AT,
      number: 1042,
    });
  });

  it.each([
    undefined,
    '',
    'not base64 json',
    Buffer.from('null').toString('base64url'),
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ u: 'yesterday', n: NUMBER })).toString('base64url'),
    Buffer.from(JSON.stringify({ u: AT.toISOString(), n: "1' or '1'='1" })).toString('base64url'),
    Buffer.from(JSON.stringify({ u: '2026-11-26', n: NUMBER })).toString('base64url'),
    'x'.repeat(300),
  ])('starts from the top for %j', (value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});
