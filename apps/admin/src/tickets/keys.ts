import type { TicketQuery } from './api.js';

/**
 * Every cache key the ticket screens use, built in one place so that an
 * invalidation and the query it is meant to reach cannot drift apart.
 *
 * The shape is `['tickets', brandId, …]`, which makes "everything about this
 * brand's tickets" a prefix. Switching brand therefore cannot show another
 * brand's rows from cache, and a socket frame for one ticket invalidates that
 * ticket rather than the desk.
 */
export const ticketKeys = {
  brand: (brandId: string) => ['tickets', brandId] as const,
  statuses: (brandId: string) => ['tickets', brandId, 'statuses'] as const,
  /** Every list, for the invalidation a created ticket needs. */
  lists: (brandId: string) => ['tickets', brandId, 'list'] as const,
  list: (brandId: string, query: TicketQuery) => ['tickets', brandId, 'list', query] as const,
  /**
   * A sidebar count. Separate from `list` on purpose: the list is read with
   * `useInfiniteQuery`, whose cache entry is `{ pages, pageParams }` rather
   * than a page, and a count sharing the key would read one shape and find the
   * other the moment both are on screen — which is every time the workspace is
   * open on the view the count is for.
   */
  count: (brandId: string, view: string) => ['tickets', brandId, 'count', view] as const,
  detail: (brandId: string, ticketId: string) => ['tickets', brandId, 'detail', ticketId] as const,
} as const;
