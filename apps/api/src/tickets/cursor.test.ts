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

  it('round-trips a numeric sort value', () => {
    const encoded = encodeTicketCursor({
      sort: 'number',
      direction: 'asc',
      value: 1042,
      id: TICKET,
    });

    expect(decodeTicketCursor(encoded, { sort: 'number', direction: 'asc' }).value).toBe(1042);
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
    // way to bounce a caller's string off it.
    const error = (() => {
      try {
        decodeTicketCursor('nope', UPDATED_AT_DESC);
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error?.message).toBe('That cursor cannot be used: it is not a cursor this api issued');
  });
});
