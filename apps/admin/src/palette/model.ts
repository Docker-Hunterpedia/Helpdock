import type { QuickSearchTicket } from '@helpdock/schemas';
import { ticketIdFromPath } from '../app/route-paths.js';
import { bestRank, type MatchRank } from './fold.js';
import { pageAt } from './pages.js';
import type { Recent } from './recents.js';

/**
 * The palette's pure parts (M14-05): what counts as an exact ticket reference,
 * how a typed query ranks the local pages and actions, how options are grouped
 * for the listbox and how the active one moves. Kept apart from the component
 * so each rule has a test that needs no DOM.
 */

/** `search` is the "See all tickets matching …" row: it has no heading of its own. */
export type PaletteGroup =
  | 'recent'
  | 'tickets'
  | 'contacts'
  | 'articles'
  | 'pages'
  | 'actions'
  | 'search';

export const GROUP_ORDER: readonly PaletteGroup[] = [
  'recent',
  'tickets',
  'contacts',
  'articles',
  'pages',
  'actions',
  'search',
];

/** How many local matches (pages, actions) a typed query shows each. */
export const LOCAL_RESULTS_LIMIT = 6;

/** How many recents the empty palette shows. */
export const RECENTS_SHOWN = 5;

export const ticketReference = (ticket: Pick<QuickSearchTicket, 'prefix' | 'number'>): string =>
  `${ticket.prefix}-${ticket.number}`;

/**
 * Whether the query names this very ticket: its reference (`HD-1042`, any
 * case, with or without the dash), `#1042` or the bare number. This is the
 * server's exact-number rule (ADR 0011) seen from the client, which only has
 * to know which row to word as "Open HD-1042".
 */
export function namesTicket(
  query: string,
  ticket: Pick<QuickSearchTicket, 'prefix' | 'number'>,
): boolean {
  const wanted = query.trim().toLowerCase().replace(/\s+/g, '');
  const prefix = ticket.prefix.toLowerCase();
  const number = String(ticket.number);
  return (
    wanted === `${prefix}-${number}` ||
    wanted === `${prefix}${number}` ||
    wanted === `#${number}` ||
    wanted === number
  );
}

/** Matches of `query` among `entries`, best first and otherwise in registry order. */
export function rankLocal<Entry>(
  query: string,
  entries: readonly Entry[],
  textsOf: (entry: Entry) => readonly string[],
  limit = LOCAL_RESULTS_LIMIT,
): Entry[] {
  return entries
    .map((entry, order) => ({ entry, order, rank: bestRank(query, textsOf(entry)) }))
    .filter(
      (candidate): candidate is typeof candidate & { rank: Exclude<MatchRank, 0> } =>
        candidate.rank > 0,
    )
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export interface Grouped<Option extends { readonly group: PaletteGroup }> {
  readonly group: PaletteGroup;
  readonly options: readonly Option[];
}

/** The options in the order the listbox shows them, split by group. */
export function groupOptions<Option extends { readonly group: PaletteGroup }>(
  options: readonly Option[],
): Grouped<Option>[] {
  return GROUP_ORDER.map((group) => ({
    group,
    options: options.filter((option) => option.group === group),
  })).filter(({ options: inGroup }) => inGroup.length > 0);
}

/** The options flattened in listbox order, so an index means the same thing to keys and to the DOM. */
export const inListOrder = <Option extends { readonly group: PaletteGroup }>(
  options: readonly Option[],
): Option[] => groupOptions(options).flatMap(({ options: inGroup }) => [...inGroup]);

/** Arrow, Home and End on a list of `count` options, wrapping at the ends. */
export function moveActive(
  current: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
  count: number,
): number {
  if (count === 0) {
    return -1;
  }
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'ArrowDown':
      return current < 0 || current >= count - 1 ? 0 : current + 1;
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1;
  }
}

/**
 * Isolates text the surrounding sentence must not reorder: a reference such as
 * `HD-1042` inside an Arabic sentence keeps its own direction. Unicode
 * isolates rather than markup, because the text is interpolated into a
 * translated string.
 */
export const isolate = (text: string): string => `⁨${text}⁩`;

const CONTACT_PATH = /^\/contacts\/([^/]+)\/?$/;
/** Segments under `/contacts` that are screens, not a contact. */
const CONTACT_SCREENS = new Set(['new', 'accounts']);

/**
 * What a visit to `pathname` adds to the recents: the ticket open in the
 * workspace, a contact's page, or a settings page. The primary pages are one
 * key away and would only push tickets out of the list.
 */
export function recentAt(pathname: string): Recent | null {
  const ticketId = ticketIdFromPath(pathname);
  if (ticketId !== null) {
    return { kind: 'ticket', id: ticketId };
  }
  const contactId = CONTACT_PATH.exec(pathname)?.[1];
  if (contactId !== undefined && !CONTACT_SCREENS.has(contactId)) {
    return { kind: 'contact', id: decodeURIComponent(contactId) };
  }
  const page = pageAt(pathname);
  return page?.group === 'settings' ? { kind: 'page', id: page.id } : null;
}
