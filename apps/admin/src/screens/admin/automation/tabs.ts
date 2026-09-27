import type { StaffRole } from '@helpdock/schemas';

/**
 * The tab row of `Admin/Automation` (artboards `AdminAutomationRules` and
 * `AdminAutomationMacros`): Rules, Time-based, Macros.
 *
 * Rules are an Admin's and a Team Leader's (DOMAIN-RULES §1.2); Macros are
 * everybody's who replies, because anyone may keep personal ones. A tab whose
 * deliverable has not landed names it, as `Admin/Ticketing`'s do.
 */

export const AUTOMATION_TABS = [
  { key: 'rules', segment: 'rules', milestone: 'M3-05', roles: ['admin', 'teamLeader'] },
  { key: 'timeBased', segment: 'time-based', milestone: 'M3-04', roles: ['admin', 'teamLeader'] },
  { key: 'macros', segment: 'macros', milestone: 'M3-06', roles: ['admin', 'teamLeader', 'agent'] },
] as const satisfies readonly {
  key: string;
  segment: string;
  milestone: string;
  roles: readonly StaffRole[];
}[];

export type AutomationTab = (typeof AUTOMATION_TABS)[number];
export type AutomationTabKey = AutomationTab['key'];

export const tabsFor = (role: StaffRole): readonly AutomationTab[] =>
  AUTOMATION_TABS.filter((tab) => (tab.roles as readonly StaffRole[]).includes(role));

export const tabForSegment = (
  tabs: readonly AutomationTab[],
  segment: string | undefined,
): AutomationTab | undefined => tabs.find((tab) => tab.segment === segment);
