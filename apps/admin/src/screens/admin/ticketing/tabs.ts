/**
 * The tab row of `Admin/Ticketing`. Every tab exists from M1-01 so the row is
 * whole and the other M1 deliverables have a place to land; the ones no
 * deliverable has filled yet draw the "not built yet" empty state.
 *
 * The milestone is on the tab rather than in prose so the empty state can name
 * it, and so the row itself is the list of what M1 still owes.
 */

export const TICKETING_TABS = [
  { key: 'departments', segment: 'departments', milestone: 'M1-01' },
  { key: 'statuses', segment: 'statuses', milestone: 'M1-08' },
  { key: 'priorities', segment: 'priorities', milestone: 'M1-02' },
  { key: 'tags', segment: 'tags', milestone: 'M1-06' },
  { key: 'customFields', segment: 'custom-fields', milestone: 'M1-06' },
  { key: 'templates', segment: 'templates', milestone: 'M1-06' },
  { key: 'views', segment: 'views', milestone: 'M1-05' },
  { key: 'assignment', segment: 'assignment', milestone: 'M1-07' },
  { key: 'spam', segment: 'spam', milestone: 'M1-11' },
] as const;

export type TicketingTab = (typeof TICKETING_TABS)[number];
export type TicketingTabKey = TicketingTab['key'];

/** Where `/admin/ticketing` with no tab goes. */
export const DEFAULT_TICKETING_TAB: TicketingTab = TICKETING_TABS[0];

export const tabForSegment = (segment: string | undefined): TicketingTab | undefined =>
  TICKETING_TABS.find((tab) => tab.segment === segment);
