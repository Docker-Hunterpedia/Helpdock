/**
 * The pages of the Inbox settings, in the order the Settings navigation lists
 * them. A segment that is not here (the old `priorities`) opens Departments.
 */

export const TICKETING_TABS = [
  { key: 'departments', segment: 'departments' },
  { key: 'statuses', segment: 'statuses' },
  { key: 'tags', segment: 'tags' },
  { key: 'customFields', segment: 'custom-fields' },
  { key: 'templates', segment: 'templates' },
  { key: 'views', segment: 'views' },
  { key: 'assignment', segment: 'assignment' },
  { key: 'spam', segment: 'spam' },
  { key: 'feedback', segment: 'feedback' },
  // M3-01 and M3-02.
  { key: 'businessHours', segment: 'business-hours' },
  { key: 'slas', segment: 'slas' },
] as const;

export type TicketingTab = (typeof TICKETING_TABS)[number];
export type TicketingTabKey = TicketingTab['key'];

/** Where `/settings/inbox` with no tab goes. */
export const DEFAULT_TICKETING_TAB: TicketingTab = TICKETING_TABS[0];

export const tabForSegment = (segment: string | undefined): TicketingTab | undefined =>
  TICKETING_TABS.find((tab) => tab.segment === segment);
