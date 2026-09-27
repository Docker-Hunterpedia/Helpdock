import type {
  BusinessHours,
  BusinessHoursOverview,
  BusinessHoursUpdateRequest,
  Department,
  Holiday,
  HolidayCreateRequest,
  SlaPolicy,
  SlaPolicyCreateRequest,
  SlaPolicyList,
  WeeklyHours,
} from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';

/**
 * The Business hours and SLAs tabs' half of `MockTicketingApi` (M3-01, M3-02):
 * a brand open Sunday to Thursday in Riyadh, as DOMAIN-RULES §3.6 draws it,
 * two holidays, and the artboard's policies.
 *
 * It holds state the way the api does, so the screens and the browser tests
 * see a save come back; what it does not do is run clocks, which is the api's.
 */

const workday = () => [{ start: '09:00', end: '17:00' }];
const riyadhWeek = (): WeeklyHours => [
  workday(),
  workday(),
  workday(),
  workday(),
  workday(),
  [],
  [],
];

const [SUPPORT, BILLING, ONBOARDING] = MOCK_DEPARTMENTS as readonly [
  Department,
  Department,
  Department,
];

export const MOCK_SLA_POLICY_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000005a1';
const MOCK_POLICY_ON_CALL = '0192c3f0-1a2b-7c3d-8e4f-0000000005a2';

const target = (firstResponseMinutes: number, resolutionMinutes: number) => ({
  firstResponseMinutes,
  resolutionMinutes,
});

const seedPolicies = (): SlaPolicy[] => [
  {
    id: MOCK_POLICY_ON_CALL,
    name: 'Onboarding on-call',
    position: 0,
    conditions: [
      { field: 'department', operator: 'any', values: [ONBOARDING.id] },
      { field: 'priority', operator: 'any', values: ['high', 'urgent'] },
    ],
    timeMode: 'calendar',
    targets: {
      low: target(480, 2880),
      medium: target(240, 1440),
      high: target(60, 480),
      urgent: target(30, 240),
    },
    escalation: [],
    runningTickets: 3,
    updatedAt: '2026-09-20T10:00:00.000Z',
    updatedBy: { id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a', name: 'Lina Haddad' },
  },
  {
    id: MOCK_SLA_POLICY_ID,
    name: 'Support and Billing',
    position: 1,
    conditions: [{ field: 'department', operator: 'any', values: [SUPPORT.id, BILLING.id] }],
    timeMode: 'business',
    targets: {
      low: target(480, 2880),
      medium: target(240, 960),
      high: target(120, 480),
      urgent: target(60, 240),
    },
    escalation: [
      {
        atPercent: 75,
        actions: [{ type: 'notify', recipient: { kind: 'department_leads' } }],
      },
      { atPercent: 100, actions: [{ type: 'set_escalated' }] },
      { atPercent: 150, actions: [{ type: 'raise_priority' }] },
    ],
    runningTickets: 23,
    updatedAt: '2026-09-21T10:00:00.000Z',
    updatedBy: { id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a', name: 'Lina Haddad' },
  },
];

const seedHolidays = (): Holiday[] => [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000006a1',
    name: 'Founding Day',
    startsOn: '2027-02-22',
    endsOn: '2027-02-22',
    departmentId: null,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000006a2',
    name: 'Year-end stock count',
    startsOn: '2026-12-30',
    endsOn: '2026-12-30',
    departmentId: BILLING.id,
  },
];

let sequence = 0;
const nextId = (): string => {
  sequence += 1;
  return `0192c3f0-1a2b-7c3d-8e4f-${String(0x7000 + sequence).padStart(12, '0')}`;
};

export class MockSlaSettings {
  #brand: BusinessHours = { timezone: 'Asia/Riyadh', weekly: riyadhWeek() };
  #overrides = new Map<string, BusinessHours>([
    [
      ONBOARDING.id,
      { timezone: 'Asia/Dubai', weekly: [[], ...Array.from({ length: 5 }, workday), []] },
    ],
  ]);
  #holidays = seedHolidays();
  #policies = seedPolicies();

  overview(
    departments: readonly { id: string; name: string; nameAr: string | null }[],
  ): BusinessHoursOverview {
    return {
      brand: this.#brand,
      departments: departments.map((department) => ({
        departmentId: department.id,
        name: department.name,
        nameAr: department.nameAr,
        override: this.#overrides.get(department.id) ?? null,
      })),
      holidays: [...this.#holidays].sort((a, b) => a.startsOn.localeCompare(b.startsOn)),
      runningTickets: 41,
    };
  }

  updateHours(request: BusinessHoursUpdateRequest): void {
    this.#brand = request.brand;
    for (const { departmentId, override } of request.departments) {
      if (override === null) {
        this.#overrides.delete(departmentId);
      } else {
        this.#overrides.set(departmentId, override);
      }
    }
  }

  createHoliday(request: HolidayCreateRequest): Holiday {
    const holiday: Holiday = {
      id: nextId(),
      name: request.name,
      startsOn: request.startsOn,
      endsOn: request.endsOn ?? request.startsOn,
      departmentId: request.departmentId ?? null,
    };
    this.#holidays = [...this.#holidays, holiday];
    return holiday;
  }

  deleteHoliday(holidayId: string): void {
    this.#holidays = this.#holidays.filter((holiday) => holiday.id !== holidayId);
  }

  policies(): SlaPolicyList {
    return { policies: [...this.#policies].sort((a, b) => a.position - b.position) };
  }

  createPolicy(request: SlaPolicyCreateRequest): SlaPolicy {
    const policy: SlaPolicy = {
      ...request,
      id: nextId(),
      position: this.#policies.length,
      runningTickets: 0,
      updatedAt: new Date().toISOString(),
      updatedBy: { id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a', name: 'Lina Haddad' },
    };
    this.#policies = [...this.#policies, policy];
    return policy;
  }

  updatePolicy(policyId: string, request: SlaPolicyCreateRequest): SlaPolicy {
    const existing = this.#require(policyId);
    const updated: SlaPolicy = { ...existing, ...request, updatedAt: new Date().toISOString() };
    this.#policies = this.#policies.map((policy) => (policy.id === policyId ? updated : policy));
    return updated;
  }

  deletePolicy(policyId: string): void {
    this.#require(policyId);
    this.#policies = this.#policies
      .filter((policy) => policy.id !== policyId)
      .map((policy, position) => ({ ...policy, position }));
  }

  reorder(policyIds: readonly string[]): SlaPolicyList {
    this.#policies = this.#policies.map((policy) => ({
      ...policy,
      position: policyIds.includes(policy.id) ? policyIds.indexOf(policy.id) : policy.position,
    }));
    return this.policies();
  }

  #require(policyId: string): SlaPolicy {
    const policy = this.#policies.find((candidate) => candidate.id === policyId);
    if (policy === undefined) {
      throw new AuthError('unavailable');
    }
    return policy;
  }
}
