import type { StaffRole } from '@helpdock/schemas';
import { FilePen, FileText, type LucideIcon, SlidersHorizontal, TrendingUp } from 'lucide-react';

/**
 * The pages of the sidebar's Help center section. An Agent sees Articles
 * alone (the artboard's footnote); a Viewer sees every page read-only;
 * changing anything is an Admin's or a Team Leader's.
 */
const TABS = [
  { key: 'articles', icon: FileText, roles: ['admin', 'teamLeader', 'agent', 'viewer'] },
  // M7-05: articles drafted from tickets, for the people who approve them.
  { key: 'proposals', icon: FilePen, roles: ['admin', 'teamLeader'] },
  { key: 'settings', icon: SlidersHorizontal, roles: ['admin', 'teamLeader', 'viewer'] },
  { key: 'insights', icon: TrendingUp, roles: ['admin', 'teamLeader', 'viewer'] },
] as const satisfies readonly { key: string; icon: LucideIcon; roles: readonly StaffRole[] }[];

export type HelpCenterTab = (typeof TABS)[number]['key'];

export const helpCenterTabsFor = (role: StaffRole) =>
  TABS.filter((tab) => (tab.roles as readonly StaffRole[]).includes(role));

/** Whether this role may change the help center (DOMAIN-RULES §1.2). */
export const managesHelpCenter = (role: StaffRole): boolean =>
  role === 'admin' || role === 'teamLeader';
