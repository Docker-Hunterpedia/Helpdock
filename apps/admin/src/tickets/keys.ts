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
  /** M1-05: the views the reader may see, for the sidebar and the Views tab. */
  views: (brandId: string) => ['tickets', brandId, 'views'] as const,
  /**
   * M1-05: the sidebar's counts, one request for every view. Under the brand
   * prefix, and apart from `list`, whose cache entry is `{ pages, pageParams }`
   * rather than a page.
   */
  counts: (brandId: string) => ['tickets', brandId, 'count'] as const,
  detail: (brandId: string, ticketId: string) => ['tickets', brandId, 'detail', ticketId] as const,
  /** M1-07: every department's picker options, for the invalidation an assignment needs. */
  assignables: (brandId: string) => ['tickets', brandId, 'assignable'] as const,
  /** M1-07: the assignee picker's options for one department. */
  assignable: (brandId: string, departmentId: string) =>
    ['tickets', brandId, 'assignable', departmentId] as const,
  /** M1-12's Time card. Under the brand prefix, so a brand switch cannot show it. */
  time: (brandId: string, ticketId: string) => ['tickets', brandId, 'time', ticketId] as const,
} as const;
