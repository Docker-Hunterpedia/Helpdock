import type {
  AssignableAgentList,
  AssignmentMode,
  BrandRole,
  OnUnassign,
  PresenceStatus,
} from '@helpdock/schemas';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../staff/mock-api.js';

/**
 * The people and settings M1-07's two fixtures share: the Assignment tab
 * (`MockTicketingApi`) and the assignee picker (`MockTicketsApi`). One roster,
 * so the tab and the picker describe the same brand, and the same people the
 * staff fixture lists — with one Agent more, so the picker has somebody
 * offline to draw.
 */

const [SUPPORT, BILLING, ONBOARDING] = MOCK_DEPARTMENTS.map((department) => department.id);
export const MOCK_SUPPORT_ID = SUPPORT ?? '';
export const MOCK_BILLING_ID = BILLING ?? '';
export const MOCK_ONBOARDING_ID = ONBOARDING ?? '';

export const MOCK_OMAR_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
export const MOCK_YARA_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000c';
export const MOCK_SAMI_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000f';

export interface MockAssignee {
  readonly userId: string;
  readonly name: string;
  readonly role: BrandRole;
  readonly departmentIds: readonly string[] | 'all';
  readonly presence: PresenceStatus;
  /** Open and escalated tickets per department. */
  readonly open: Readonly<Record<string, number>>;
}

export const MOCK_ASSIGNEES: readonly MockAssignee[] = [
  {
    userId: MOCK_SELF_ID,
    name: 'Lina Haddad',
    role: 'admin',
    departmentIds: 'all',
    presence: 'online',
    open: { [MOCK_SUPPORT_ID]: 3, [MOCK_BILLING_ID]: 1 },
  },
  {
    userId: MOCK_OMAR_ID,
    name: 'Omar Nasser',
    role: 'team_leader',
    departmentIds: [MOCK_SUPPORT_ID],
    presence: 'online',
    open: { [MOCK_SUPPORT_ID]: 8 },
  },
  {
    userId: MOCK_YARA_ID,
    name: 'Yara Salem',
    role: 'agent',
    departmentIds: [MOCK_SUPPORT_ID, MOCK_BILLING_ID],
    presence: 'away',
    open: { [MOCK_SUPPORT_ID]: 2 },
  },
  {
    userId: MOCK_SAMI_ID,
    name: 'Sami Aziz',
    role: 'agent',
    departmentIds: [MOCK_SUPPORT_ID],
    presence: 'offline',
    open: {},
  },
];

export interface MockDepartmentAssignment {
  readonly mode: AssignmentMode;
  readonly loadCap: number | null;
  readonly autoUnassignOffline: boolean;
  readonly autoUnassignAfterMinutes: number;
  readonly onUnassign: OnUnassign;
}

/** Support routes by round-robin with a cap of 8, as the artboard's Billing row does. */
export const seedAssignmentSettings = (): Record<string, MockDepartmentAssignment> => ({
  [MOCK_SUPPORT_ID]: {
    mode: 'round_robin',
    loadCap: 8,
    autoUnassignOffline: true,
    autoUnassignAfterMinutes: 15,
    onUnassign: 'round_robin',
  },
  [MOCK_BILLING_ID]: {
    mode: 'skill_based',
    loadCap: 6,
    autoUnassignOffline: true,
    autoUnassignAfterMinutes: 30,
    onUnassign: 'leave_unassigned',
  },
  [MOCK_ONBOARDING_ID]: {
    mode: 'manual',
    loadCap: null,
    autoUnassignOffline: false,
    autoUnassignAfterMinutes: 15,
    onUnassign: 'leave_unassigned',
  },
});

/** The api's `canWorkDepartment`, for the fixture. */
export const worksIn = (assignee: MockAssignee, departmentId: string): boolean =>
  assignee.role !== 'viewer' &&
  (assignee.role === 'admin' ||
    assignee.departmentIds === 'all' ||
    assignee.departmentIds.includes(departmentId));

/** What the picker reads. The session is Lina, an Admin, so nobody is above her ceiling. */
export const mockAssignable = (departmentId: string): AssignableAgentList => ({
  departmentId,
  loadCap: seedAssignmentSettings()[departmentId]?.loadCap ?? null,
  agents: MOCK_ASSIGNEES.filter((assignee) => worksIn(assignee, departmentId)).map((assignee) => ({
    userId: assignee.userId,
    name: assignee.name,
    presence: assignee.presence,
    openCount: assignee.open[departmentId] ?? 0,
  })),
});
