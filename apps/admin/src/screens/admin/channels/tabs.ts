/**
 * The tab row of `Admin/Channels`. Mailboxes is M2-08's; Outgoing email is
 * M2-05's and lands in its own branch, so until then it draws the "not built
 * yet" state that names its deliverable, as the Ticketing tabs did in M1.
 */
export const CHANNELS_TABS = [
  { key: 'mailboxes', segment: 'mailboxes', milestone: 'M2-08' },
  { key: 'outgoing', segment: 'outgoing', milestone: 'M2-05' },
] as const;

export type ChannelsTab = (typeof CHANNELS_TABS)[number];
export type ChannelsTabKey = ChannelsTab['key'];

export const DEFAULT_CHANNELS_TAB: ChannelsTab = CHANNELS_TABS[0];

export const channelsTabForSegment = (segment: string | undefined): ChannelsTab | undefined =>
  CHANNELS_TABS.find((tab) => tab.segment === segment);
