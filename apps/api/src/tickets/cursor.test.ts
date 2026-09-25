import { describe, expect, it } from 'vitest';
import { decodeTicketCursor, encodeTicketCursor, InvalidCursorError } from './cursor.js';

const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';
const UPDATED_AT_DESC = { sort: 'updatedAt', direction: 'desc' } as const;

describe('ticket cursors', () => {
  it('round-trips the row it points at', () => {
    const encoded = encodeTicketCursor({
      ...UPDATED_AT_DESC,
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
    });

    expect(decodeTicketCursor(encoded, UPDATED_AT_DESC)).toEqual({
      ...UPDATED_AT_DESC,
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
    });
  });

  it('round-trips the fuzzy fallback of a search (ADR 0011)', () => {
    const encoded = encodeTicketCursor({
      ...UPDATED_AT_DESC,
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
      fuzzy: true,
    });

    expect(decodeTicketCursor(encoded, UPDATED_AT_DESC).fuzzy).toBe(true);
  });

  it('says nothing about a fallback that did not happen', () => {
    const encoded = encodeTicketCursor({
      ...UPDATED_AT_DESC,
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
    });

    expect(decodeTicketCursor(encoded, UPDATED_AT_DESC)).not.toHaveProperty('fuzzy');
  });

  it('round-trips a numeric sort value', () => {
    const encoded = encodeTicketCursor({
      sort: 'number',
      direction: 'asc',
      value: 1042,
      id: TICKET,
    });

    expect(decodeTicketCursor(encoded, { sort: 'number', direction: 'asc' }).value).toBe(1042);
  });

  it('round-trips a priority, which orders by the enum’s own declaration order', () => {
    const encoded = encodeTicketCursor({
      sort: 'priority',
      direction: 'desc',
      value: 'high',
      id: TICKET,
    });

    expect(decodeTicketCursor(encoded, { sort: 'priority', direction: 'desc' }).value).toBe('high');
  });

  it('is url-safe, because it travels in a query string', () => {
    const encoded = encodeTicketCursor({
      ...UPDATED_AT_DESC,
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
    });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a cursor issued for another sort', () => {
    // Comparing a timestamp against a ticket number would return a page that
    // looks right and is not, so it is refused rather than reinterpreted.
    const encoded = encodeTicketCursor({
      ...UPDATED_AT_DESC,
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
    });

    expect(() => decodeTicketCursor(encoded, { sort: 'number', direction: 'desc' })).toThrow(
      /different sort order/,
    );
  });

  it('refuses a cursor issued for the other direction', () => {
    const encoded = encodeTicketCursor({
      ...UPDATED_AT_DESC,
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
    });

    expect(() => decodeTicketCursor(encoded, { sort: 'updatedAt', direction: 'asc' })).toThrow(
      InvalidCursorError,
    );
  });

  it('refuses something that is not base64 at all', () => {
    expect(() => decodeTicketCursor('!!!not a cursor!!!', UPDATED_AT_DESC)).toThrow(
      InvalidCursorError,
    );
  });

  it('refuses a well-formed encoding of the wrong shape', () => {
    const forged = Buffer.from(JSON.stringify({ s: 'updatedAt' }), 'utf8').toString('base64url');

    expect(() => decodeTicketCursor(forged, UPDATED_AT_DESC)).toThrow(InvalidCursorError);
  });

  it.each([
    ['a number sort carrying a word', { s: 'number', d: 'desc', v: 'abc', id: TICKET }],
    ['a timestamp sort carrying a number', { s: 'updatedAt', d: 'desc', v: 7, id: TICKET }],
    ['a timestamp sort carrying a word', { s: 'createdAt', d: 'desc', v: 'yesterday', id: TICKET }],
    [
      'a priority sort carrying a label nobody has',
      { s: 'priority', d: 'desc', v: 'x', id: TICKET },
    ],
  ])('refuses %s, so the comparison cannot raise inside Postgres', (_name, forged) => {
    // Without the per-sort type, the value reaches a row comparison against a
    // typed column and Postgres answers `invalid input syntax` — a 500 and an
    // error log for what is a caller's malformed input.
    const encoded = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');

    expect(() =>
      decodeTicketCursor(encoded, {
        sort: forged.s as 'number',
        direction: 'desc',
      }),
    ).toThrow(InvalidCursorError);
  });

  it('refuses an id that is not a uuid', () => {
    // The value reaches a comparison against a uuid column, so its shape is
    // checked rather than assumed.
    const forged = Buffer.from(
      JSON.stringify({ s: 'updatedAt', d: 'desc', v: 'x', id: "'; drop table tickets --" }),
      'utf8',
    ).toString('base64url');

    expect(() => decodeTicketCursor(forged, UPDATED_AT_DESC)).toThrow(InvalidCursorError);
  });

  it('names what is wrong without echoing the cursor back', () => {
    // The message is rendered in a 400. Echoing the input would make the api a
    // way to bounce a caller's own string off it.
    const error = (() => {
      try {
        decodeTicketCursor('SGVsbG8taW5qZWN0ZWQ', UPDATED_AT_DESC);
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error?.message).toContain('not a cursor this api issued');
    expect(error?.message).not.toContain('SGVsbG8taW5qZWN0ZWQ');
    expect(error?.message).not.toContain('Hello-injected');
  });
});
