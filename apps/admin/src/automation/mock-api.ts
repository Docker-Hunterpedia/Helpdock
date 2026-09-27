import {
  type ActionOutcome,
  evaluateConditions,
  firstFailedGroup,
  type RuleAction,
  type RuleBuilderOptions,
  type RuleCreateRequest,
  type RuleKind,
  type RuleRunQuery,
  type RuleTestFollowOn,
  type RuleTestRunRequest,
  type RuleTestRunResult,
  type RuleTicketFacts,
  type RuleTrigger,
  type RuleUpdateRequest,
  ruleDraftSchema,
  ruleTestRunRequestSchema,
  type WorkflowRule,
  type WorkflowRuleList,
  type WorkflowRun,
  type WorkflowRunList,
} from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import type { AutomationApi } from './api.js';

/**
 * The fixture behind the mock admin: the `AdminAutomationRules` artboard's
 * seven rules and its log — including the loop the depth guard stopped on
 * HD-1041 — and two sample tickets for the test run.
 *
 * The test run evaluates conditions with `evaluateConditions` from
 * `@helpdock/schemas`, the code the engine itself runs, so a draft that
 * matches here matches there. What the actions would do is judged against the
 * fixture ticket's own fields, which is the same question the api asks.
 */

const id = (n: number): string => `0193a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const MOCK_AUTOMATION = {
  statuses: {
    open: id(101),
    awaiting: id(102),
    vendor: id(103),
    closed: id(104),
    escalated: id(105),
  },
  departments: { support: id(201), sales: id(202), billing: id(203) },
  teams: { billing: id(301), technical: id(302), sales: id(303), returns: id(304) },
  tags: { refund: id(401), vip: id(402), billing: id(403), slaBreach: id(404) },
  members: { karim: id(501), omar: id(502), lina: id(503) },
  canned: { refundReceived: id(601), orderStatus: id(602), closing: id(603) },
  tickets: { hd1042: id(701), hd1039: id(702), hd1041: id(703), hd1038: id(704) },
} as const;

const M = MOCK_AUTOMATION;

const OPTIONS: RuleBuilderOptions = {
  statuses: [
    { id: M.statuses.open, name: 'Open', nameAr: 'مفتوحة' },
    { id: M.statuses.awaiting, name: 'Awaiting customer', nameAr: 'بانتظار العميل' },
    { id: M.statuses.vendor, name: 'Waiting on vendor', nameAr: 'بانتظار المورّد' },
    { id: M.statuses.escalated, name: 'Escalated', nameAr: 'مصعّدة' },
    { id: M.statuses.closed, name: 'Closed', nameAr: 'مغلقة' },
  ],
  departments: [
    { id: M.departments.support, name: 'Support', nameAr: 'الدعم' },
    { id: M.departments.sales, name: 'Sales', nameAr: 'المبيعات' },
    { id: M.departments.billing, name: 'Billing', nameAr: 'الفوترة' },
  ],
  teams: [
    { id: M.teams.billing, name: 'Billing', departmentId: M.departments.billing },
    { id: M.teams.technical, name: 'Technical', departmentId: M.departments.support },
    { id: M.teams.sales, name: 'Sales', departmentId: M.departments.sales },
    { id: M.teams.returns, name: 'Returns', departmentId: M.departments.support },
  ],
  tags: [
    { id: M.tags.refund, name: 'refund', nameAr: null },
    { id: M.tags.vip, name: 'vip', nameAr: null },
    { id: M.tags.billing, name: 'billing', nameAr: null },
    { id: M.tags.slaBreach, name: 'sla-breach', nameAr: null },
  ],
  members: [
    { id: M.members.karim, name: 'Karim Nasser' },
    { id: M.members.lina, name: 'Lina Haddad' },
    { id: M.members.omar, name: 'Omar Aziz' },
  ],
  accounts: [{ id: id(801), name: 'Acme Trading' }],
  customFields: [{ key: 'order_number', label: 'Order number', labelAr: 'رقم الطلب' }],
  cannedResponses: [
    { id: M.canned.refundReceived, name: 'Refund received' },
    { id: M.canned.orderStatus, name: 'Order status' },
    { id: M.canned.closing, name: 'Closing: no reply in 3 days' },
  ],
};

interface MockTicket {
  readonly id: string;
  readonly reference: string;
  readonly contactName: string;
  readonly facts: RuleTicketFacts;
}

const TICKETS: readonly MockTicket[] = [
  {
    id: M.tickets.hd1042,
    reference: 'HD-1042',
    contactName: 'Mona K.',
    facts: {
      subject: 'Refund not received after 10 days',
      body: 'I returned the order two weeks ago.',
      channel: 'email',
      departmentId: M.departments.billing,
      teamId: null,
      assigneeId: null,
      priority: 'medium',
      statusId: M.statuses.open,
      statusChangedAt: new Date('2026-09-27T11:02:00Z'),
      tagIds: [M.tags.refund],
      contactEmails: ['mona.k@example.com'],
      accountId: null,
      custom: { order_number: '88412' },
    },
  },
  {
    id: M.tickets.hd1039,
    reference: 'HD-1039',
    contactName: 'سلمى ع.',
    facts: {
      subject: 'استفسار عن رسوم الشحن الدولي',
      body: '',
      channel: 'chat',
      departmentId: M.departments.sales,
      teamId: null,
      assigneeId: null,
      priority: 'low',
      statusId: M.statuses.open,
      statusChangedAt: new Date('2026-09-26T09:00:00Z'),
      tagIds: [],
      contactEmails: [],
      accountId: null,
      custom: {},
    },
  },
];

const group = (
  match: 'all' | 'any',
  conditions: RuleCreateRequest['conditions']['groups'][0]['conditions'],
) => ({
  match,
  conditions,
});

const SEED_RULES: readonly RuleCreateRequest[] = [
  {
    name: 'Refunds to Billing',
    description: 'New refund requests go straight to Billing with an acknowledgment.',
    kind: 'event',
    trigger: 'ticket_created',
    conditions: {
      match: 'all',
      groups: [
        group('any', [
          { field: 'subject', operator: 'contains', values: ['refund'] },
          { field: 'subject', operator: 'contains', values: ['استرداد'] },
        ]),
        group('all', [
          { field: 'channel', operator: 'any_of', values: ['email', 'chat', 'form'] },
          { field: 'custom_field', key: 'order_number', operator: 'is_set', values: [] },
        ]),
      ],
    },
    actions: [
      { type: 'assign_team', teamId: M.teams.billing },
      { type: 'send_canned', cannedResponseId: M.canned.refundReceived, countsAsResponse: false },
      { type: 'add_tag', tagId: M.tags.refund },
      { type: 'notify', recipient: { kind: 'department_leads' } },
    ],
  },
  {
    name: 'Telegram to Sales',
    kind: 'event',
    trigger: 'ticket_created',
    conditions: {
      match: 'all',
      groups: [group('all', [{ field: 'channel', operator: 'is', values: ['telegram'] }])],
    },
    actions: [{ type: 'assign_team', teamId: M.teams.sales }],
  },
  {
    name: 'Invoices to Returns',
    kind: 'event',
    trigger: 'assigned',
    conditions: {
      match: 'all',
      groups: [
        group('all', [
          { field: 'subject', operator: 'contains', values: ['invoice'] },
          { field: 'team', operator: 'is', values: [M.teams.billing] },
        ]),
      ],
    },
    actions: [{ type: 'assign_team', teamId: M.teams.returns }],
  },
  {
    name: 'Returns back to Billing',
    kind: 'event',
    trigger: 'assigned',
    conditions: {
      match: 'all',
      groups: [
        group('all', [
          { field: 'team', operator: 'is', values: [M.teams.returns] },
          { field: 'tag', operator: 'is', values: [M.tags.billing] },
        ]),
      ],
    },
    actions: [{ type: 'assign_team', teamId: M.teams.billing }],
  },
  {
    name: 'VIP tag raises priority',
    kind: 'event',
    trigger: 'tag_added',
    conditions: {
      match: 'all',
      groups: [group('all', [{ field: 'tag', operator: 'is', values: [M.tags.vip] }])],
    },
    actions: [{ type: 'set_priority', priority: 'high' }],
  },
  {
    name: 'Escalate on SLA breach',
    kind: 'event',
    trigger: 'sla_breached',
    conditions: { match: 'all', groups: [] },
    actions: [
      { type: 'add_tag', tagId: M.tags.slaBreach },
      { type: 'notify', recipient: { kind: 'department_leads' } },
    ],
  },
  {
    name: 'Web form to Sales',
    kind: 'event',
    trigger: 'ticket_created',
    enabled: false,
    conditions: {
      match: 'all',
      groups: [group('all', [{ field: 'channel', operator: 'is', values: ['form'] }])],
    },
    actions: [{ type: 'assign_team', teamId: M.teams.sales }],
  },
  {
    name: 'Close after 3 days awaiting customer',
    kind: 'scheduled',
    intervalMinutes: 15,
    conditions: {
      match: 'all',
      groups: [
        group('all', [
          { field: 'status', operator: 'is', values: [M.statuses.awaiting] },
          {
            field: 'time_in_status',
            operator: 'more_than',
            values: [],
            duration: { amount: 3, unit: 'days' },
          },
        ]),
      ],
    },
    actions: [
      { type: 'send_canned', cannedResponseId: M.canned.closing, countsAsResponse: false },
      { type: 'close' },
    ],
  },
];

const STATS: readonly [string | null, number][] = [
  ['2026-09-27T14:02:00Z', 128],
  ['2026-09-27T14:02:00Z', 311],
  ['2026-09-27T13:40:00Z', 9],
  ['2026-09-27T13:40:00Z', 9],
  ['2026-09-27T13:12:00Z', 42],
  ['2026-09-27T12:15:00Z', 17],
  [null, 0],
  ['2026-09-27T12:00:00Z', 6],
];

const CREATED = '2026-09-01T09:00:00.000Z';

const buildRule = (
  draft: RuleCreateRequest,
  ruleId: string,
  position: number,
  stats: readonly [string | null, number] = [null, 0],
): WorkflowRule => {
  const parsed = ruleDraftSchema.parse(draft);
  return {
    id: ruleId,
    name: parsed.name,
    description: parsed.description ?? null,
    kind: parsed.kind,
    trigger: parsed.kind === 'event' ? (parsed.trigger ?? null) : null,
    intervalMinutes: parsed.kind === 'scheduled' ? (parsed.intervalMinutes ?? null) : null,
    conditions: parsed.conditions,
    actions: parsed.actions,
    position,
    enabled: parsed.enabled,
    lastAppliedAt: stats[0] === null ? null : new Date(stats[0]).toISOString(),
    appliedLast30Days: stats[1],
    createdAt: CREATED,
    updatedAt: CREATED,
  };
};

export const MOCK_RULE_IDS = SEED_RULES.map((_rule, index) => id(901 + index));

const seedRules = (): WorkflowRule[] => {
  const positions = { event: 0, scheduled: 0 };
  return SEED_RULES.map((draft, index) => {
    positions[draft.kind] += 1;
    return buildRule(draft, MOCK_RULE_IDS[index] ?? id(999), positions[draft.kind], STATS[index]);
  });
};

const run = (
  runId: number,
  rule: number,
  ticket: { id: string; reference: string },
  at: string,
  rest: Partial<WorkflowRun>,
): WorkflowRun => ({
  id: id(1000 + runId),
  ruleId: MOCK_RULE_IDS[rule] ?? '',
  ruleName: SEED_RULES[rule]?.name ?? '',
  ticketId: ticket.id,
  ticketReference: ticket.reference,
  trigger: SEED_RULES[rule]?.trigger ?? 'schedule',
  result: 'applied',
  stopReason: null,
  depth: 1,
  chain: [],
  failedGroup: null,
  actions: [],
  createdAt: at,
  ...rest,
});

const ago = (now: number, minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const HD1042 = { id: M.tickets.hd1042, reference: 'HD-1042' };
const HD1041 = { id: M.tickets.hd1041, reference: 'HD-1041' };
const HD1038 = { id: M.tickets.hd1038, reference: 'HD-1038' };
const link = (rule: number) => ({
  ruleId: MOCK_RULE_IDS[rule] ?? '',
  ruleName: SEED_RULES[rule]?.name ?? '',
});

/** The artboard's log, dated minutes before `now` so the loop is always "today". */
const seedRuns = (now: number): readonly WorkflowRun[] => [
  run(6, 0, HD1042, ago(now, 3), {
    actions: [
      { action: { type: 'assign_team', teamId: M.teams.billing }, effect: 'changed' },
      {
        action: {
          type: 'send_canned',
          cannedResponseId: M.canned.refundReceived,
          countsAsResponse: false,
        },
        effect: 'changed',
      },
    ],
  }),
  run(5, 1, HD1042, ago(now, 3), {
    result: 'skipped',
    failedGroup: {
      match: 'all',
      outcome: 'failed',
      conditions: [
        {
          condition: { field: 'channel', operator: 'is', values: ['telegram'] },
          outcome: 'failed',
          actual: ['email'],
        },
      ],
    },
  }),
  run(4, 2, HD1041, ago(now, 25), {
    result: 'stopped',
    stopReason: 'cycle',
    depth: 3,
    chain: [link(2), link(3)],
  }),
  run(3, 3, HD1041, ago(now, 26), {
    depth: 2,
    chain: [link(2)],
    actions: [{ action: { type: 'assign_team', teamId: M.teams.billing }, effect: 'changed' }],
  }),
  run(2, 2, HD1041, ago(now, 27), {
    actions: [{ action: { type: 'assign_team', teamId: M.teams.returns }, effect: 'changed' }],
  }),
  run(1, 4, HD1038, ago(now, 53), {
    actions: [{ action: { type: 'set_priority', priority: 'high' }, effect: 'changed' }],
  }),
];

const ticketNumber = (reference: string): string | null => {
  const match = /^(?:[A-Za-z]+-)?(\d+)$/.exec(reference.trim());
  return match?.[1] ?? null;
};

/** What the draft's actions would do to a fixture ticket, and the ticket they would leave. */
const preview = (
  facts: RuleTicketFacts,
  actions: readonly RuleAction[],
): { outcomes: ActionOutcome[]; after: RuleTicketFacts; triggers: Set<RuleTrigger> } => {
  let after = facts;
  const triggers = new Set<RuleTrigger>();
  const outcomes = actions.map((action): ActionOutcome => {
    switch (action.type) {
      case 'assign_team': {
        if (after.teamId === action.teamId) {
          return { action, effect: 'unchanged' };
        }
        after = { ...after, teamId: action.teamId };
        triggers.add('assigned');
        return { action, effect: 'changed' };
      }
      case 'add_tag': {
        if (after.tagIds.includes(action.tagId)) {
          return { action, effect: 'unchanged' };
        }
        after = { ...after, tagIds: [...after.tagIds, action.tagId] };
        triggers.add('tag_added');
        return { action, effect: 'changed' };
      }
      case 'set_priority': {
        if (after.priority === action.priority) {
          return { action, effect: 'unchanged' };
        }
        after = { ...after, priority: action.priority };
        return { action, effect: 'changed' };
      }
      case 'notify':
        return action.recipient.kind === 'assignee' && after.assigneeId === null
          ? { action, effect: 'unavailable' }
          : { action, effect: 'changed', recipientIds: [M.members.karim] };
      default:
        return { action, effect: 'changed' };
    }
  });
  return { outcomes, after, triggers };
};

const context = {
  now: new Date('2026-09-27T14:05:00Z'),
  withinBusinessHours: true,
  includeText: true,
};

export class MockAutomationApi implements AutomationApi {
  #rules: WorkflowRule[] = seedRules();
  #runs: readonly WorkflowRun[];

  constructor(now: number = Date.now()) {
    this.#runs = seedRuns(now);
  }
  #next = 2000;

  async rules(_brandId: string, kind?: RuleKind): Promise<WorkflowRuleList> {
    await Promise.resolve();
    return {
      rules: this.#rules
        .filter((rule) => kind === undefined || rule.kind === kind)
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.position - b.position),
    };
  }

  async createRule(_brandId: string, request: RuleCreateRequest): Promise<WorkflowRule> {
    await Promise.resolve();
    this.#next += 1;
    const draft = ruleDraftSchema.parse(request);
    const position = this.#rules.filter((rule) => rule.kind === draft.kind).length + 1;
    const created = buildRule(request, id(this.#next), position);
    this.#rules = [...this.#rules, created];
    return created;
  }

  async updateRule(
    _brandId: string,
    ruleId: string,
    request: RuleUpdateRequest,
  ): Promise<WorkflowRule> {
    const current = this.#require(ruleId);
    await Promise.resolve();
    const updated = {
      ...buildRule(request, ruleId, current.position),
      lastAppliedAt: current.lastAppliedAt,
      appliedLast30Days: current.appliedLast30Days,
    };
    this.#rules = this.#rules.map((rule) => (rule.id === ruleId ? updated : rule));
    return updated;
  }

  async setRuleEnabled(_brandId: string, ruleId: string, enabled: boolean): Promise<WorkflowRule> {
    const updated = { ...this.#require(ruleId), enabled };
    await Promise.resolve();
    this.#rules = this.#rules.map((rule) => (rule.id === ruleId ? updated : rule));
    return updated;
  }

  async deleteRule(_brandId: string, ruleId: string): Promise<void> {
    this.#require(ruleId);
    await Promise.resolve();
    this.#rules = this.#rules.filter((rule) => rule.id !== ruleId);
  }

  async reorderRules(
    brandId: string,
    kind: RuleKind,
    ruleIds: readonly string[],
  ): Promise<WorkflowRuleList> {
    await Promise.resolve();
    this.#rules = this.#rules.map((rule) =>
      rule.kind === kind ? { ...rule, position: ruleIds.indexOf(rule.id) + 1 } : rule,
    );
    return this.rules(brandId, kind);
  }

  async runs(_brandId: string, query: RuleRunQuery): Promise<WorkflowRunList> {
    await Promise.resolve();
    const q = query.q?.trim().toLocaleLowerCase() ?? '';
    return {
      runs: this.#runs.filter(
        (entry) =>
          (query.result === undefined || entry.result === query.result) &&
          (q === '' ||
            entry.ruleName.toLocaleLowerCase().includes(q) ||
            entry.ticketReference.toLocaleLowerCase() === q),
      ),
    };
  }

  async options(_brandId: string): Promise<RuleBuilderOptions> {
    await Promise.resolve();
    return OPTIONS;
  }

  async testRun(_brandId: string, request: RuleTestRunRequest): Promise<RuleTestRunResult> {
    await Promise.resolve();
    const parsed = ruleTestRunRequestSchema.parse(request);
    const number = ticketNumber(parsed.ticket);
    const ticket = TICKETS.find((candidate) => candidate.reference === `HD-${number}`);
    if (ticket === undefined) {
      return { outcome: null };
    }

    const outcome = evaluateConditions(parsed.rule.conditions, ticket.facts, context);
    const summary = {
      id: ticket.id,
      reference: ticket.reference,
      subject: ticket.facts.subject,
      contactName: ticket.contactName,
      channel: ticket.facts.channel,
      departmentName:
        OPTIONS.departments.find((department) => department.id === ticket.facts.departmentId)
          ?.name ?? '',
      teamName: null,
      assigneeName: null,
      tagNames: ticket.facts.tagIds.map(
        (tagId) => OPTIONS.tags.find((tag) => tag.id === tagId)?.name ?? '',
      ),
    };
    if (!outcome.matched) {
      return {
        outcome: {
          ticket: summary,
          wouldRun: false,
          groups: [...outcome.groups],
          actions: [],
          followOns: [],
        },
      };
    }

    const { outcomes, after, triggers } = preview(ticket.facts, parsed.rule.actions);
    const followOns = this.#rules
      .filter(
        (rule) =>
          rule.enabled &&
          rule.kind === 'event' &&
          rule.trigger !== null &&
          triggers.has(rule.trigger) &&
          rule.id !== parsed.ruleId,
      )
      .map((rule): RuleTestFollowOn => {
        const judged = evaluateConditions(rule.conditions, after, context);
        return {
          trigger: rule.trigger ?? 'ticket_updated',
          ruleId: rule.id,
          ruleName: rule.name,
          depth: 2,
          outcome: judged.matched ? 'would_run' : 'would_skip',
          failedGroup: firstFailedGroup(judged),
        };
      });

    return {
      outcome: {
        ticket: summary,
        wouldRun: true,
        groups: [...outcome.groups],
        actions: outcomes,
        followOns,
      },
    };
  }

  #require(ruleId: string): WorkflowRule {
    const found = this.#rules.find((rule) => rule.id === ruleId);
    if (found === undefined) {
      throw new AuthError('unavailable');
    }
    return found;
  }
}
