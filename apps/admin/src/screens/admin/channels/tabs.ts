import type { StaffRole } from '@helpdock/schemas';
import { FileText, Inbox, type LucideIcon, MessageCircle, Send } from 'lucide-react';

/**
 * The tab row of `Admin/Channels`: Mailboxes (M2-02, M2-03, M2-08's inbound
 * half), Outgoing email (M2-05, M2-06, M2-08's outbound half), Widget (M4)
 * and Web form (M4-09). Mailboxes, Outgoing email and Web form are the
 * Admin's; a Team Leader owns the widget's look, conversation and content
 * policy (DOMAIN-RULES §1.2), so `/admin/channels` lands on the first tab the
 * viewer may open.
 */
export interface ChannelsTab {
  readonly key: 'mailboxes' | 'outgoing' | 'widget' | 'webForm';
  readonly segment: string;
  readonly icon: LucideIcon;
  readonly roles: readonly StaffRole[];
}

export const CHANNELS_TABS: readonly ChannelsTab[] = [
  { key: 'mailboxes', segment: 'mailboxes', icon: Inbox, roles: ['admin'] },
  { key: 'outgoing', segment: 'outgoing', icon: Send, roles: ['admin'] },
  { key: 'widget', segment: 'widget', icon: MessageCircle, roles: ['admin', 'teamLeader'] },
  { key: 'webForm', segment: 'web-form', icon: FileText, roles: ['admin'] },
];

export type ChannelsTabKey = ChannelsTab['key'];

/** The tabs a role may open, in order. */
export const channelsTabsFor = (role: StaffRole): readonly ChannelsTab[] =>
  CHANNELS_TABS.filter((tab) => tab.roles.includes(role));

export const channelsTabForSegment = (
  segment: string | undefined,
  role: StaffRole,
): ChannelsTab | undefined => channelsTabsFor(role).find((tab) => tab.segment === segment);
