import type { RuleKind, StaffRole } from '@helpdock/schemas';

/**
 * The tab row of `Admin/Automation` (artboards `AdminAutomationRules`,
 * `AdminAutomationMacros` and `Admin/Automation-Routing`): Rules, Time-based,
 * Routing, Macros.
 *
 * Rules are an Admin's and a Team Leader's (DOMAIN-RULES §1.2); Macros are
 * everybody's who replies, because anyone may keep personal ones. Routing
 * (M14-09) explains the rules and the assignment settings, so it follows the
 * rules' audience. `kind` is the kind of rule a tab lists, and null for Routing
 * and Macros, which list none.
 */

export const AUTOMATION_TABS = [
  { key: 'rules', segment: 'rules', kind: 'event', roles: ['admin', 'teamLeader'] },
  { key: 'timeBased', segment: 'time-based', kind: 'scheduled', roles: ['admin', 'teamLeader'] },
  { key: 'routing', segment: 'routing', kind: null, roles: ['admin', 'teamLeader'] },
  { key: 'macros', segment: 'macros', kind: null, roles: ['admin', 'teamLeader', 'agent'] },
] as const satisfies readonly {
  key: string;
  segment: string;
  kind: RuleKind | null;
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

/** The tab a rule's builder sits under: its kind's list. */
export const tabOfKind = (kind: RuleKind): AutomationTab =>
  kind === 'scheduled' ? AUTOMATION_TABS[1] : AUTOMATION_TABS[0];
