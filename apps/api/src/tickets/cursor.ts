import type { TicketSort, TicketSortDirection } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * Keyset pagination for the ticket list (REQUIREMENTS §5.2: p95 under 150 ms at
 * 50k tickets per brand).
 *
 * An offset cannot deliver that. `OFFSET 10000` makes Postgres walk ten
 * thousand rows it then throws away, and it also *skips* rows: a ticket that is
 * updated between page 2 and page 3 moves to the front of an `updated_at`
 * ordering and the reader never sees it. A cursor says "the row after this
 * one", which is stable under writes and is an index seek.
 *
 * The cursor is opaque to the client and is *not* a token: it carries nothing
 * secret and grants nothing. Every row it can reach is a row row-level security
 * would have shown anyway, so a forged cursor is a differently-ordered page,
 * never another department's tickets. It is validated all the same, because a
 * value from a query string reaches a comparison against a typed column.
 */

const direction = z.enum(['asc', 'desc']);

/**
 * The sort key of the last row on a page, and its id as the tiebreaker.
 *
 * `v` is typed **per sort**, not as "a string or a number". The value reaches
 * a row comparison against a typed column, so a cursor claiming
 * `{"s":"number","v":"abc"}` would otherwise be accepted here and raise
 * `invalid input syntax for type bigint` in Postgres — a 500 and an error log
 * for what is a caller's malformed input. No rows could leak either way, since
 * a cursor only reorders a page row-level security has already scoped, but
 * "the caller's mistake answers 400" is the contract this file states.
 */
export const ticketCursorSchema = z.discriminatedUnion('s', [
  z.object({ s: z.literal('updatedAt'), d: direction, v: z.iso.datetime(), id: z.uuid() }),
  z.object({ s: z.literal('createdAt'), d: direction, v: z.iso.datetime(), id: z.uuid() }),
  z.object({ s: z.literal('number'), d: direction, v: z.int().positive(), id: z.uuid() }),
  z.object({
    s: z.literal('priority'),
    d: direction,
    v: z.enum(['low', 'medium', 'high', 'urgent']),
    id: z.uuid(),
  }),
]);

export interface TicketCursor {
  readonly sort: TicketSort;
  readonly direction: TicketSortDirection;
  readonly value: string | number;
  readonly id: string;
}

/** A cursor that does not decode, or that belongs to a different ordering. */
export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`That cursor cannot be used: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

export const encodeTicketCursor = ({ sort, direction, value, id }: TicketCursor): string =>
  Buffer.from(JSON.stringify({ s: sort, d: direction, v: value, id }), 'utf8').toString(
    'base64url',
  );

/**
 * The cursor, or a refusal naming what is wrong with it. A cursor read under a
 * different sort is refused rather than reinterpreted: comparing an id against
 * a timestamp would silently return the wrong page, and a client that changed
 * the sort has to start from the top anyway.
 */
export const decodeTicketCursor = (
  encoded: string,
  expected: { readonly sort: TicketSort; readonly direction: TicketSortDirection },
): TicketCursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('it is not a cursor this api issued');
  }

  const cursor = ticketCursorSchema.safeParse(parsed);
  if (!cursor.success) {
    throw new InvalidCursorError('it is not a cursor this api issued');
  }

  if (cursor.data.s !== expected.sort || cursor.data.d !== expected.direction) {
    throw new InvalidCursorError('it was issued for a different sort order');
  }

  return {
    sort: cursor.data.s,
    direction: cursor.data.d,
    value: cursor.data.v,
    id: cursor.data.id,
  };
};
