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

/** The sort key of the last row on a page, and its id as the tiebreaker. */
export const ticketCursorSchema = z.object({
  /** The sort the page was read under. A cursor from another sort is refused. */
  s: z.enum(['updatedAt', 'createdAt', 'number', 'priority']),
  d: z.enum(['asc', 'desc']),
  /** The sort column's value: an ISO timestamp, a number, or a priority. */
  v: z.union([z.string().max(64), z.number()]),
  id: z.uuid(),
});

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
