import type { CustomerSees } from '@helpdock/schemas';
import { parseTicketReference, type TicketReference } from './ticket-reference.js';

/**
 * What a customer asked the ticket list for, as plain values (M21-03). The
 * query string is untrusted: every field is checked here and anything unknown
 * falls back to the default, so the reader below only ever sees a valid query.
 */

export const PAGE_SIZE = 20;
export const SEARCH_MAX = 100;

export type ListScope = 'mine' | 'company';
export type ListState = 'open' | 'solved';

/**
 * Where the next page starts: the last row's `(updated_at, number)`, newest
 * first. The number is the ticket's public reference, unique in a brand, so it
 * breaks ties between rows changed at the same instant and no internal id ever
 * leaves the server.
 */
export interface ListCursor {
  readonly updatedAt: Date;
  readonly number: number;
}

export type ListSearch =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'text';
      /** The text, trimmed, for a case-insensitive "contains" on the subject. */
      readonly text: string;
      /** The reference or bare number the text also names, matched exactly. */
      readonly reference: TicketReference | { readonly number: number } | null;
    };

export interface TicketListQuery {
  readonly scope: ListScope;
  readonly state: ListState;
  readonly search: ListSearch;
  readonly cursor: ListCursor | null;
}

export interface RawListQuery {
  readonly scope?: string | undefined;
  readonly state?: string | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
}

export const encodeCursor = (cursor: ListCursor): string =>
  Buffer.from(JSON.stringify({ u: cursor.updatedAt.toISOString(), n: cursor.number })).toString(
    'base64url',
  );

/** A cursor this module made, or null: a forged or mangled one starts from the top. */
export const decodeCursor = (value: string | undefined): ListCursor | null => {
  if (value === undefined || value === '' || value.length > 200) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { u, n } = parsed as { u?: unknown; n?: unknown };
    if (typeof u !== 'string' || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
      return null;
    }
    const updatedAt = new Date(u);
    return Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== u
      ? null
      : { updatedAt, number: n };
  } catch {
    return null;
  }
};

/** Whether the customer's account setting lets them switch to the company's tickets. */
export const mayViewCompany = (sees: CustomerSees): boolean => sees === 'account';

export const parseSearch = (value: string | undefined): ListSearch => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX);
  if (text === '') {
    return { kind: 'none' };
  }
  const reference = parseTicketReference(text);
  if (reference !== null) {
    return { kind: 'text', text, reference };
  }
  const bare = /^#?([0-9]{1,12})$/.exec(text);
  const number = bare === null ? 0 : Number(bare[1]);
  return {
    kind: 'text',
    text,
    reference: Number.isSafeInteger(number) && number > 0 ? { number } : null,
  };
};

/** `%`, `_` and the escape character, escaped so a search for `50%` is not a wildcard. */
export const likePattern = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

export const parseListQuery = (raw: RawListQuery, sees: CustomerSees): TicketListQuery => ({
  scope: raw.scope === 'company' && mayViewCompany(sees) ? 'company' : 'mine',
  state: raw.state === 'solved' ? 'solved' : 'open',
  search: parseSearch(raw.q),
  cursor: decodeCursor(raw.cursor),
});
