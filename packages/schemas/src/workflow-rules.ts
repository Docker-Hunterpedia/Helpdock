import { z } from 'zod';
import { ticketChannelSchema, ticketPrioritySchema } from './ticket.js';

/**
 * Workflow rules (M3-03, M3-04, M3-05; REQUIREMENTS §4.3):
 * `WHEN <event> IF <conditions> THEN <actions>`, ordered per brand, plus the
 * time-based rules that run on the `rules` cron queue over matching tickets.
 *
 * **One rule shape for both kinds.** An event rule names a {@link ruleTriggerSchema};
 * a scheduled rule names an interval instead. Conditions and actions are the
 * same vocabulary, so the builder is one form with a "Runs" switch, as the
 * `AdminRuleBuilder` artboard draws it.
 *
 * **The depth guard** (REQUIREMENTS §4.3: "rules cannot trigger themselves in a
 * loop (max depth 3, cycle detection)"). A rule's actions can set off other
 * rules; the chain of rules that led to a change travels with its outbox
 * event, and a run that would be the fourth in a chain, or would run a rule a
 * second time in one chain, is stopped before it acts and logged as such.
 */

/** A chain is at most this many rules long (REQUIREMENTS §4.3). */
export const RULE_MAX_DEPTH = 3;

export const RULE_NAME_MAX_LENGTH = 120;
export const RULE_DESCRIPTION_MAX_LENGTH = 300;
export const MAX_RULES_PER_BRAND = 200;
export const MAX_RULE_GROUPS = 10;
export const MAX_RULE_CONDITIONS_PER_GROUP = 20;
export const MAX_RULE_ACTIONS = 20;
export const RULE_TEXT_VALUE_MAX_LENGTH = 500;
export const RULE_NOTE_MAX_LENGTH = 5_000;
export const RULE_NOTIFY_MESSAGE_MAX_LENGTH = 500;

/**
 * The events of REQUIREMENTS §4.3 a rule may be started by. "Article viewed"
 * has no ticket and is analytics-only, so it is not one of them.
 */
export const ruleTriggerSchema = z.enum([
  'ticket_created',
  'ticket_updated',
  'customer_replied',
  'agent_replied',
  'status_changed',
  'assigned',
  'tag_added',
  'sla_warning',
  'sla_breached',
  'csat_received',
]);
export type RuleTrigger = z.infer<typeof ruleTriggerSchema>;

export const ruleKindSchema = z.enum(['event', 'scheduled']);
export type RuleKind = z.infer<typeof ruleKindSchema>;

/** The intervals the builder offers for a scheduled rule, in minutes. */
export const RULE_INTERVALS_MINUTES = [15, 30, 60, 360, 1440] as const;
export const ruleIntervalSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(360),
  z.literal(1440),
]);
export type RuleInterval = z.infer<typeof ruleIntervalSchema>;

// ----------------------------------------------------------------- conditions

export const ruleConditionFieldSchema = z.enum([
  'subject',
  'body',
  'channel',
  'department',
  'team',
  'assignee',
  'priority',
  'status',
  'tag',
  'contact_email',
  'account',
  'time_in_status',
  'business_hours',
  'custom_field',
]);
export type RuleConditionField = z.infer<typeof ruleConditionFieldSchema>;

export const ruleOperatorSchema = z.enum([
  'contains',
  'not_contains',
  'is',
  'is_not',
  'any_of',
  'is_set',
  'more_than',
  'less_than',
]);
export type RuleOperator = z.infer<typeof ruleOperatorSchema>;

/** What each field's values are, which decides its operators and how values are checked. */
export type RuleFieldValueKind =
  | 'text'
  | 'channel'
  | 'priority'
  | 'id'
  | 'duration'
  | 'business_hours';

export const RULE_FIELD_VALUE_KIND: Readonly<Record<RuleConditionField, RuleFieldValueKind>> = {
  subject: 'text',
  body: 'text',
  contact_email: 'text',
  custom_field: 'text',
  channel: 'channel',
  priority: 'priority',
  department: 'id',
  team: 'id',
  assignee: 'id',
  status: 'id',
  tag: 'id',
  account: 'id',
  time_in_status: 'duration',
  business_hours: 'business_hours',
};

/**
 * Which operators each field accepts. The builder draws exactly these, and the
 * schema refuses anything else, so a stored rule can never ask the engine a
 * question it has no answer for.
 */
export const RULE_OPERATORS_BY_FIELD: Readonly<
  Record<RuleConditionField, readonly RuleOperator[]>
> = {
  subject: ['contains', 'not_contains', 'is', 'is_not', 'is_set'],
  body: ['contains', 'not_contains'],
  contact_email: ['contains', 'not_contains', 'is', 'is_not', 'is_set'],
  custom_field: ['contains', 'not_contains', 'is', 'is_not', 'is_set'],
  channel: ['is', 'is_not', 'any_of'],
  priority: ['is', 'is_not', 'any_of'],
  department: ['is', 'is_not', 'any_of'],
  team: ['is', 'is_not', 'any_of', 'is_set'],
  assignee: ['is', 'is_not', 'any_of', 'is_set'],
  status: ['is', 'is_not', 'any_of'],
  tag: ['is', 'is_not', 'any_of', 'is_set'],
  account: ['is', 'is_not', 'any_of', 'is_set'],
  time_in_status: ['more_than', 'less_than'],
  business_hours: ['is'],
};

export const ruleDurationSchema = z.object({
  amount: z.int().min(1).max(10_000),
  unit: z.enum(['hours', 'days']),
});
export type RuleDuration = z.infer<typeof ruleDurationSchema>;

/** Minutes in a {@link RuleDuration}. */
export const ruleDurationMinutes = ({ amount, unit }: RuleDuration): number =>
  amount * (unit === 'days' ? 1_440 : 60);

const CUSTOM_FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;

const valueProblem = (
  kind: RuleFieldValueKind,
  operator: RuleOperator,
  values: readonly string[],
): string | null => {
  if (operator === 'is_set' || kind === 'duration') {
    return values.length === 0 ? null : 'takes no values';
  }
  if (values.length === 0) {
    return 'needs a value';
  }
  if (operator !== 'any_of' && values.length !== 1) {
    return 'takes exactly one value';
  }

  switch (kind) {
    case 'channel':
      return values.every((value) => ticketChannelSchema.safeParse(value).success)
        ? null
        : 'names a channel that does not exist';
    case 'priority':
      return values.every((value) => ticketPrioritySchema.safeParse(value).success)
        ? null
        : 'names a priority that does not exist';
    case 'id':
      return values.every((value) => z.uuid().safeParse(value).success) ? null : 'must be ids';
    case 'business_hours':
      return values[0] === 'inside' || values[0] === 'outside' ? null : 'must be inside or outside';
    default:
      return values.every((value) => value.trim().length > 0) ? null : 'must not be blank';
  }
};

export const ruleConditionSchema = z
  .object({
    field: ruleConditionFieldSchema,
    operator: ruleOperatorSchema,
    values: z.array(z.string().max(RULE_TEXT_VALUE_MAX_LENGTH)).max(50).default([]),
    /** The custom field's key, for `custom_field` only. */
    key: z.string().regex(CUSTOM_FIELD_KEY).optional(),
    /** `time_in_status` only. */
    duration: ruleDurationSchema.optional(),
  })
  .superRefine((condition, context) => {
    const { field, operator, values, key, duration } = condition;

    if (!RULE_OPERATORS_BY_FIELD[field].includes(operator)) {
      context.addIssue({
        code: 'custom',
        path: ['operator'],
        message: `${field} does not take ${operator}`,
      });
      return;
    }

    const kind = RULE_FIELD_VALUE_KIND[field];
    const problem = valueProblem(kind, operator, values);
    if (problem !== null) {
      context.addIssue({ code: 'custom', path: ['values'], message: `${field} ${problem}` });
    }
    if ((field === 'custom_field') !== (key !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['key'],
        message: 'a custom field condition names its key, and no other condition does',
      });
    }
    if ((kind === 'duration') !== (duration !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['duration'],
        message: 'time in status takes a duration, and no other condition does',
      });
    }
  });
export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export type RuleConditionInput = z.input<typeof ruleConditionSchema>;

export const ruleMatchSchema = z.enum(['all', 'any']);
export type RuleMatch = z.infer<typeof ruleMatchSchema>;

export const ruleConditionGroupSchema = z.object({
  match: ruleMatchSchema,
  conditions: z.array(ruleConditionSchema).min(1).max(MAX_RULE_CONDITIONS_PER_GROUP),
});
export type RuleConditionGroup = z.infer<typeof ruleConditionGroupSchema>;

/** No groups means "every ticket": a rule that runs on each event it is started by. */
export const ruleConditionsSchema = z.object({
  match: ruleMatchSchema,
  groups: z.array(ruleConditionGroupSchema).max(MAX_RULE_GROUPS),
});
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

// -------------------------------------------------------------------- actions

/** Who a `notify` action reaches. One recipient per action; add another action for more. */
export const ruleNotifyRecipientSchema = z.discriminatedUnion('kind', [
  /** The Team Leaders whose scope reaches the ticket's department. */
  z.object({ kind: z.literal('department_leads') }),
  z.object({ kind: z.literal('assignee') }),
  z.object({ kind: z.literal('team'), teamId: z.uuid() }),
  z.object({ kind: z.literal('user'), userId: z.uuid() }),
]);
export type RuleNotifyRecipient = z.infer<typeof ruleNotifyRecipientSchema>;

export const ruleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_status'), statusId: z.uuid() }),
  z.object({ type: z.literal('set_priority'), priority: ticketPrioritySchema }),
  z.object({
    type: z.literal('set_field'),
    key: z.string().regex(CUSTOM_FIELD_KEY),
    value: z.string().max(RULE_TEXT_VALUE_MAX_LENGTH).nullable(),
  }),
  z.object({ type: z.literal('assign_team'), teamId: z.uuid() }),
  z.object({ type: z.literal('assign_agent'), userId: z.uuid() }),
  z.object({ type: z.literal('assign_round_robin') }),
  z.object({ type: z.literal('add_tag'), tagId: z.uuid() }),
  z.object({ type: z.literal('remove_tag'), tagId: z.uuid() }),
  z.object({
    type: z.literal('send_canned'),
    cannedResponseId: z.uuid(),
    /**
     * DOMAIN-RULES §3.1: a workflow canned reply never stops the
     * first-response clock unless the rule says so. Off by default.
     */
    countsAsResponse: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('add_note'),
    body: z.string().trim().min(1).max(RULE_NOTE_MAX_LENGTH),
  }),
  z.object({
    type: z.literal('notify'),
    recipient: ruleNotifyRecipientSchema,
    message: z.string().trim().max(RULE_NOTIFY_MESSAGE_MAX_LENGTH).nullish(),
  }),
  /** Moves the ticket to the brand's Escalated status (DOMAIN-RULES §2.1). */
  z.object({ type: z.literal('escalate') }),
  /** Moves the ticket to the brand's Closed status, as an agent closing it would. */
  z.object({ type: z.literal('close') }),
]);
export type RuleAction = z.infer<typeof ruleActionSchema>;
export type RuleActionInput = z.input<typeof ruleActionSchema>;
export type RuleActionType = RuleAction['type'];

export const RULE_ACTION_TYPES = [
  'set_status',
  'set_priority',
  'set_field',
  'assign_team',
  'assign_agent',
  'assign_round_robin',
  'add_tag',
  'remove_tag',
  'send_canned',
  'add_note',
  'notify',
  'escalate',
  'close',
] as const satisfies readonly RuleActionType[];

// ---------------------------------------------------------------------- rules

const ruleNameSchema = z.string().trim().min(1).max(RULE_NAME_MAX_LENGTH);

const ruleBodySchema = z.object({
  name: ruleNameSchema,
  description: z.string().trim().max(RULE_DESCRIPTION_MAX_LENGTH).nullish(),
  kind: ruleKindSchema,
  trigger: ruleTriggerSchema.nullish(),
  intervalMinutes: ruleIntervalSchema.nullish(),
  conditions: ruleConditionsSchema,
  actions: z.array(ruleActionSchema).min(1).max(MAX_RULE_ACTIONS),
  enabled: z.boolean().default(true),
});

/** An event rule names its event and no interval; a scheduled rule the other way round. */
const kindIsConsistent = (
  rule: { kind: RuleKind; trigger?: unknown; intervalMinutes?: unknown },
  context: z.RefinementCtx,
): void => {
  const hasTrigger = rule.trigger !== null && rule.trigger !== undefined;
  const hasInterval = rule.intervalMinutes !== null && rule.intervalMinutes !== undefined;

  if (rule.kind === 'event' && (!hasTrigger || hasInterval)) {
    context.addIssue({
      code: 'custom',
      path: ['trigger'],
      message: 'an event rule names its event and no interval',
    });
  }
  if (rule.kind === 'scheduled' && (hasTrigger || !hasInterval)) {
    context.addIssue({
      code: 'custom',
      path: ['intervalMinutes'],
      message: 'a scheduled rule names its interval and no event',
    });
  }
};

/** What the builder saves. Also what a test run tries, unsaved. */
export const ruleDraftSchema = ruleBodySchema.superRefine(kindIsConsistent);
export type RuleDraft = z.infer<typeof ruleDraftSchema>;
export type RuleDraftInput = z.input<typeof ruleDraftSchema>;

export const ruleCreateRequestSchema = ruleDraftSchema;
export type RuleCreateRequest = RuleDraftInput;

/** The whole rule, as the builder sends it on save; enabling alone is `ruleToggleRequestSchema`. */
export const ruleUpdateRequestSchema = ruleDraftSchema;
export type RuleUpdateRequest = RuleDraftInput;

export const ruleToggleRequestSchema = z.object({ enabled: z.boolean() });
export type RuleToggleRequest = z.infer<typeof ruleToggleRequestSchema>;

/** Every rule of one kind, in its new order. The server refuses a partial list. */
export const ruleReorderRequestSchema = z.object({
  kind: ruleKindSchema,
  ruleIds: z.array(z.uuid()).min(1).max(MAX_RULES_PER_BRAND),
});
export type RuleReorderRequest = z.infer<typeof ruleReorderRequestSchema>;

export const workflowRuleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  kind: ruleKindSchema,
  trigger: ruleTriggerSchema.nullable(),
  intervalMinutes: ruleIntervalSchema.nullable(),
  conditions: ruleConditionsSchema,
  actions: z.array(ruleActionSchema),
  /** 1-based place in its kind's list: the order rules for one event run in. */
  position: z.int().positive(),
  enabled: z.boolean(),
  /** When it last acted on a ticket. */
  lastAppliedAt: z.iso.datetime().nullable(),
  /** How many times it acted in the last 30 days. */
  appliedLast30Days: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkflowRule = z.infer<typeof workflowRuleSchema>;

export const workflowRuleListSchema = z.object({ rules: z.array(workflowRuleSchema) });
export type WorkflowRuleList = z.infer<typeof workflowRuleListSchema>;

export const ruleParamSchema = z.object({ brandId: z.uuid(), ruleId: z.uuid() });
export type RuleParam = z.infer<typeof ruleParamSchema>;

export const ruleListQuerySchema = z.object({ kind: ruleKindSchema.optional() });
export type RuleListQuery = z.infer<typeof ruleListQuerySchema>;

// ---------------------------------------------------------------- the log

export const ruleRunResultSchema = z.enum(['applied', 'skipped', 'stopped', 'failed']);
export type RuleRunResult = z.infer<typeof ruleRunResultSchema>;

/** Why the depth guard stopped a run. */
export const ruleStopReasonSchema = z.enum(['cycle', 'depth']);
export type RuleStopReason = z.infer<typeof ruleStopReasonSchema>;

/** What one condition was asked and what it found. */
export const conditionTraceSchema = z.object({
  condition: ruleConditionSchema,
  outcome: z.enum(['matched', 'failed', 'not_needed']),
  /**
   * What the ticket holds for that field: ids, a channel, a priority. Text
   * fields are left out of the stored log (`null`), because the log outlives
   * the reader's view of the ticket; a test run, read by somebody who can see
   * the ticket, carries them.
   */
  actual: z.array(z.string()).nullable(),
});
export type ConditionTrace = z.infer<typeof conditionTraceSchema>;

export const groupTraceSchema = z.object({
  match: ruleMatchSchema,
  outcome: z.enum(['matched', 'failed', 'not_needed']),
  conditions: z.array(conditionTraceSchema),
});
export type GroupTrace = z.infer<typeof groupTraceSchema>;

export const actionOutcomeSchema = z.object({
  action: ruleActionSchema,
  /**
   * `changed`: it did something. `unchanged`: the ticket already was that way,
   * so nothing was written and nothing else was set off. `unavailable`: it
   * could not be done — a team that was deleted, an agent who cannot work the
   * department, a canned response that no longer exists.
   */
  effect: z.enum(['changed', 'unchanged', 'unavailable']),
  /** For `notify`, who it reached. */
  recipientIds: z.array(z.uuid()).optional(),
});
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;

export const ruleChainLinkSchema = z.object({ ruleId: z.uuid(), ruleName: z.string() });
export type RuleChainLink = z.infer<typeof ruleChainLinkSchema>;

export const workflowRunSchema = z.object({
  id: z.uuid(),
  ruleId: z.uuid(),
  ruleName: z.string(),
  ticketId: z.uuid(),
  /** `HD-1042`. */
  ticketReference: z.string(),
  /** The event, or `schedule` for a time-based run. */
  trigger: z.union([ruleTriggerSchema, z.literal('schedule')]),
  result: ruleRunResultSchema,
  stopReason: ruleStopReasonSchema.nullable(),
  /** 1 for a run started by a person or a channel; one more for each rule before it. */
  depth: z.int().positive(),
  /** The rules that ran before this one in the same chain, oldest first. */
  chain: z.array(ruleChainLinkSchema),
  /** Present on `skipped`: the first group that did not match. */
  failedGroup: groupTraceSchema.nullable(),
  /** Present on `applied`. */
  actions: z.array(actionOutcomeSchema),
  createdAt: z.iso.datetime(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const workflowRunListSchema = z.object({ runs: z.array(workflowRunSchema) });
export type WorkflowRunList = z.infer<typeof workflowRunListSchema>;

export const RULE_RUNS_PAGE_SIZE = 100;

export const ruleRunQuerySchema = z.object({
  result: ruleRunResultSchema.optional(),
  /** A rule's name, or a ticket reference such as `HD-1042`. */
  q: z.string().trim().max(RULE_NAME_MAX_LENGTH).optional(),
  ruleId: z.uuid().optional(),
});
export type RuleRunQuery = z.infer<typeof ruleRunQuerySchema>;

// ------------------------------------------------------------ the test run

export const ruleTestRunRequestSchema = z.object({
  rule: ruleDraftSchema,
  /** `HD-1042`, or the number alone. */
  ticket: z.string().trim().min(1).max(40),
  /** The saved rule this draft edits, so it is not counted twice in "could set off". */
  ruleId: z.uuid().optional(),
});
export type RuleTestRunRequest = z.input<typeof ruleTestRunRequestSchema>;

export const ruleTestTicketSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  subject: z.string(),
  contactName: z.string().nullable(),
  channel: ticketChannelSchema,
  departmentName: z.string(),
  teamName: z.string().nullable(),
  assigneeName: z.string().nullable(),
  tagNames: z.array(z.string()),
});
export type RuleTestTicket = z.infer<typeof ruleTestTicketSchema>;

export const ruleTestFollowOnSchema = z.object({
  trigger: ruleTriggerSchema,
  ruleId: z.uuid(),
  ruleName: z.string(),
  depth: z.int().positive(),
  outcome: z.enum(['would_run', 'would_skip', 'would_stop']),
  failedGroup: groupTraceSchema.nullable(),
});
export type RuleTestFollowOn = z.infer<typeof ruleTestFollowOnSchema>;

export const ruleTestRunOutcomeSchema = z.object({
  ticket: ruleTestTicketSchema,
  wouldRun: z.boolean(),
  groups: z.array(groupTraceSchema),
  actions: z.array(actionOutcomeSchema),
  followOns: z.array(ruleTestFollowOnSchema),
});
export type RuleTestRunOutcome = z.infer<typeof ruleTestRunOutcomeSchema>;

/**
 * A reference that names no ticket the reader can see is an answer, not a
 * failure: the panel says so beside the field, as the artboard draws it. It
 * does not say which of "no such ticket" and "not yours" it was.
 */
export const ruleTestRunResultSchema = z.object({
  /** Null when the reference names no ticket the reader can see. */
  outcome: ruleTestRunOutcomeSchema.nullable(),
});
export type RuleTestRunResult = z.infer<typeof ruleTestRunResultSchema>;

// ------------------------------------------------- what the builder offers

const namedSchema = z.object({ id: z.uuid(), name: z.string(), nameAr: z.string().nullable() });

/**
 * Everything the builder's selects are filled from, in one read: a rule names
 * statuses, departments, teams, tags, people, custom fields and canned
 * responses by id, and the builder shows them by name.
 */
export const ruleBuilderOptionsSchema = z.object({
  statuses: z.array(namedSchema),
  departments: z.array(namedSchema),
  teams: z.array(z.object({ id: z.uuid(), name: z.string(), departmentId: z.uuid() })),
  tags: z.array(namedSchema),
  members: z.array(z.object({ id: z.uuid(), name: z.string() })),
  accounts: z.array(z.object({ id: z.uuid(), name: z.string() })),
  customFields: z.array(
    z.object({ key: z.string(), label: z.string(), labelAr: z.string().nullable() }),
  ),
  /** Empty until M3-06's canned responses are wired in. */
  cannedResponses: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type RuleBuilderOptions = z.infer<typeof ruleBuilderOptionsSchema>;

/** The most accounts the builder lists; a brand with more types the rest by search in M8. */
export const RULE_OPTIONS_ACCOUNTS_MAX = 200;

// --------------------------------------------------------- the outbox seam

/**
 * The event a `notify` action writes (M3-03). M3-07's notifications consume
 * it; the rules engine only resolves who the recipients are.
 */
export const RULE_NOTIFY_EVENT = 'rule.notify';

export const ruleNotifyPayloadSchema = z.object({
  ticketId: z.uuid(),
  recipients: z.array(z.uuid()).max(500),
  /** The rule's own message, or null for the default "a rule wants your attention". */
  message: z.string().max(RULE_NOTIFY_MESSAGE_MAX_LENGTH).nullable(),
  ruleId: z.uuid(),
});
export type RuleNotifyPayload = z.infer<typeof ruleNotifyPayloadSchema>;
