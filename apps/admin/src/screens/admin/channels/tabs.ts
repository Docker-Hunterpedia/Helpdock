import { Inbox, type LucideIcon, Send } from 'lucide-react';

/**
 * The tab row of `Admin/Channels`: Mailboxes (M2-02, M2-03, M2-08's inbound
 * half) first, so `/admin/channels` lands on it, then Outgoing email (M2-05,
 * M2-06, M2-08's outbound half).
 */
export const CHANNELS_TABS: readonly [
  { readonly key: 'mailboxes'; readonly segment: 'mailboxes'; readonly icon: LucideIcon },
  { readonly key: 'outgoing'; readonly segment: 'outgoing'; readonly icon: LucideIcon },
] = [
  { key: 'mailboxes', segment: 'mailboxes', icon: Inbox },
  { key: 'outgoing', segment: 'outgoing', icon: Send },
];

export type ChannelsTab = (typeof CHANNELS_TABS)[number];
export type ChannelsTabKey = ChannelsTab['key'];

export const DEFAULT_CHANNELS_TAB: ChannelsTab = CHANNELS_TABS[0];

export const channelsTabForSegment = (segment: string | undefined): ChannelsTab | undefined =>
  CHANNELS_TABS.find((tab) => tab.segment === segment);
