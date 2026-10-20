import {
  type ActionOutcome,
  evaluateConditions,
  type RoutingEntryPoint,
  type RoutingOverview,
  type RoutingTestInput,
  type RoutingTestResult,
  type RoutingTestRule,
  type RuleAction,
  type RuleBuilderOptions,
  type RuleTicketFacts,
  routingTestRequestSchema,
  type WorkflowRule,
} from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';

/**
 * The fixture behind the Routing tab and Test routing (`Admin/Automation-Routing`):
 * a brand with two mailboxes, the widget, a Telegram bot and a web form, the
 * `ticket_created` rules of the rules fixture, and two departments' rotations.
 *
 * The walk judges the sample with `evaluateConditions`, the code the api's
 * dry run uses, so a rule that matches here matches there. A few senders stand
 * for the cases the board draws:
 *
 * - `rana@globex.com` is on the block list;
 * - `noreply@…` is an automated sender;
 * - `away@…` files into a department whose people are all away;
 * - `fail@…` makes the test itself fail, for the failure path.
 */

const id = (n: number): string => `0193a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const MOCK_ROUTING = {
  mailboxes: { billing: id(1101), support: id(1102) },
  bot: id(1103),
  senders: {
    blocked: 'rana@globex.com',
    automated: 'noreply@shop.example',
    away: 'away@globex.com',
    failing: 'fail@globex.com',
    known: 'mona.k@example.com',
  },
} as const;

type Preview = (
  facts: RuleTicketFacts,
  actions: readonly RuleAction[],
) => { outcomes: ActionOutcome[]; after: RuleTicketFacts };

const NOW = new Date('2026-10-20T13:00:00Z');
const FIRST_RESPONSE_DUE = '2026-10-21T13:00:00.000Z';

const department = (options: RuleBuilderOptions, departmentId: string) => {
  const found = options.departments.find((entry) => entry.id === departmentId);
  return { id: departmentId, name: found?.name ?? '', nameAr: found?.nameAr ?? null };
};

const entryPoints = (options: RuleBuilderOptions): RoutingEntryPoint[] => {
  const [support, , billing] = options.departments;
  const named = (entry: typeof support) =>
    entry === undefined ? null : department(options, entry.id);
  const base = { platform: null, enabled: true } as const;

  return [
    {
      ...base,
      entry: 'mailbox',
      entryId: MOCK_ROUTING.mailboxes.billing,
      label: 'billing@helpdock.com',
      channel: 'email',
      department: named(billing),
      reason: 'entry_department',
    },
    {
      ...base,
      entry: 'mailbox',
      entryId: MOCK_ROUTING.mailboxes.support,
      label: 'support@helpdock.com',
      channel: 'email',
      department: named(support),
      reason: 'entry_department',
    },
    {
      ...base,
      entry: 'widget',
      entryId: null,
      label: null,
      channel: 'chat',
      department: named(support),
      reason: 'brand_first_department',
    },
    {
      ...base,
      entry: 'telegram_bot',
      entryId: MOCK_ROUTING.bot,
      label: '@helpdock_bot',
      channel: 'telegram',
      department: named(support),
      reason: 'entry_department',
    },
    {
      ...base,
      entry: 'web_form',
      entryId: null,
      label: null,
      channel: 'form',
      department: named(support),
      reason: 'brand_first_department',
    },
    {
      ...base,
      entry: 'api_key',
      entryId: null,
      label: null,
      channel: 'api',
      department: null,
      reason: 'named_by_api',
    },
  ];
};

export const mockRoutingOverview = (
  rules: readonly WorkflowRule[],
  options: RuleBuilderOptions,
): RoutingOverview => {
  const created = rules
    .filter((rule) => rule.kind === 'event' && rule.trigger === 'ticket_created')
    .sort((a, b) => a.position - b.position);
  const [support, , billing] = options.departments;

  return {
    entryPoints: entryPoints(options),
    rules: created.map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      actions: rule.actions,
    })),
    triageRules: created
      .filter((rule) => rule.enabled && rule.actions.some((action) => action.type === 'ai_triage'))
      .map((rule) => ({ id: rule.id, name: rule.name })),
    assignment: [
      ...(billing === undefined
        ? []
        : [
            {
              department: department(options, billing.id),
              mode: 'round_robin' as const,
              loadCap: null,
              peopleInRotation: 4,
            },
          ]),
      ...(support === undefined
        ? []
        : [
            {
              department: department(options, support.id),
              mode: 'skill_based' as const,
              loadCap: 8,
              peopleInRotation: 3,
            },
          ]),
    ],
  };
};

export const mockRoutingTest = (
  rules: readonly WorkflowRule[],
  options: RuleBuilderOptions,
  preview: Preview,
  request: unknown,
): RoutingTestResult => {
  const input: RoutingTestInput = routingTestRequestSchema.parse(request);
  const door = entryPoints(options).find(
    (entry) => entry.entry === input.entry && entry.entryId === input.entryId,
  );
  if (door === undefined || input.from === MOCK_ROUTING.senders.failing) {
    throw new AuthError('unavailable');
  }
  const departmentId = door.department?.id ?? input.departmentId;
  if (departmentId === undefined) {
    throw new AuthError('unavailable');
  }
  const arrival = {
    entry: door.entry,
    label: door.label,
    channel: door.channel,
    department: department(options, departmentId),
    reason: door.reason,
  };
  const nothing = {
    contact: null,
    rules: [],
    ticket: null,
    triage: null,
    sla: null,
    assignment: null,
  };

  const gated = door.entry !== 'widget' && door.entry !== 'api_key';
  if (door.entry === 'mailbox' && input.from.startsWith('noreply@')) {
    return { entry: arrival, verdict: 'automated', ...nothing };
  }
  if (gated && input.from === MOCK_ROUTING.senders.blocked) {
    return { entry: arrival, verdict: 'blocked', ...nothing };
  }

  const known = input.from === MOCK_ROUTING.senders.known;
  let facts: RuleTicketFacts = {
    subject: input.subject,
    body: input.message,
    channel: door.channel,
    departmentId,
    teamId: null,
    assigneeId: null,
    priority: 'medium',
    statusId: options.statuses[0]?.id ?? '',
    statusChangedAt: NOW,
    tagIds: [],
    contactEmails: input.from === '' ? [] : [input.from],
    accountId: null,
    custom: {},
  };
  const initial = facts;
  const context = { now: NOW, withinBusinessHours: true, includeText: true };

  const walked: RoutingTestRule[] = [];
  let triage = false;
  for (const rule of rules
    .filter(
      (entry) => entry.enabled && entry.kind === 'event' && entry.trigger === 'ticket_created',
    )
    .sort((a, b) => a.position - b.position)) {
    const outcome = evaluateConditions(rule.conditions, initial, context);
    if (!outcome.matched) {
      walked.push({
        ruleId: rule.id,
        name: rule.name,
        matched: false,
        groups: [...outcome.groups],
        actions: [],
        followOns: [],
      });
      continue;
    }
    const { outcomes, after } = preview(facts, rule.actions);
    const team = options.teams.find((entry) => entry.id === after.teamId);
    facts = { ...after, departmentId: team?.departmentId ?? after.departmentId };
    triage ||= rule.actions.some((action) => action.type === 'ai_triage');
    walked.push({
      ruleId: rule.id,
      name: rule.name,
      matched: true,
      groups: [...outcome.groups],
      actions: outcomes,
      followOns: [],
    });
  }

  const finalDepartment = department(options, facts.departmentId);
  const billing = options.departments.find((entry) => entry.name === 'Billing');
  const team = options.teams.find((entry) => entry.id === facts.teamId);
  const assignment: RoutingTestResult['assignment'] =
    facts.departmentId === billing?.id
      ? input.from === MOCK_ROUTING.senders.away
        ? { kind: 'nobody_online', mode: 'round_robin' }
        : {
            kind: 'picked',
            mode: 'round_robin',
            assignee: { id: options.members[2]?.id ?? '', name: options.members[2]?.name ?? '' },
          }
      : { kind: 'manual' };

  return {
    entry: arrival,
    verdict: 'ticket',
    contact: known
      ? { kind: 'matched', name: 'Mona K.', matchedBy: 'email' }
      : { kind: 'new', name: input.fromName === '' ? null : input.fromName },
    rules: walked,
    ticket: {
      department: finalDepartment,
      team: team === undefined ? null : { id: team.id, name: team.name },
      priority: facts.priority,
      tagNames: facts.tagIds.map(
        (tagId) => options.tags.find((tag) => tag.id === tagId)?.name ?? '',
      ),
    },
    triage: triage ? 'queued' : 'not_queued',
    sla: { policy: { id: id(1201), name: 'Standard' }, firstResponseDueAt: FIRST_RESPONSE_DUE },
    assignment,
  };
};
