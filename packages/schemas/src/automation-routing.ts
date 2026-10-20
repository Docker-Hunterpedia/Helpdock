import { z } from 'zod';
import { assignmentModeSchema } from './assignment.js';
import { metaPlatformSchema } from './meta.js';
import { ticketChannelSchema, ticketPrioritySchema } from './ticket.js';
import {
  actionOutcomeSchema,
  groupTraceSchema,
  ruleActionSchema,
  ruleTestFollowOnSchema,
} from './workflow-rules.js';

/**
 * M14-09: the Routing tab of Admin › Automation and its Test routing dry run
 * (DOMAIN-RULES §2.9).
 *
 * The overview explains the pipeline a new ticket goes through, in four steps
 * (arrival, rules on *Ticket created*, AI triage, assignment). The dry run
 * walks the same code with a sample message and writes nothing.
 */

/** A department as these screens name it: it exists, so it has a name. */
export const routingDepartmentRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nameAr: z.string().nullable(),
});
export type RoutingDepartmentRef = z.infer<typeof routingDepartmentRefSchema>;

/** The doors a customer's message can come in through; a staff member or an import is not one. */
export const routingEntryKindSchema = z.enum([
  'mailbox',
  'widget',
  'web_form',
  'telegram_bot',
  'meta_account',
  'api_key',
]);
export type RoutingEntryKind = z.infer<typeof routingEntryKindSchema>;

/** Why an entry point files into the department it does. */
export const routingEntryReasonSchema = z.enum([
  'entry_department',
  'brand_first_department',
  'named_by_api',
]);
export type RoutingEntryReason = z.infer<typeof routingEntryReasonSchema>;

export const routingEntryPointSchema = z.object({
  entry: routingEntryKindSchema,
  /** Null for the brand's one widget and one web form, and for the API, which has no door of its own. */
  entryId: z.uuid().nullable(),
  /** The mailbox address, `@bot` username or account name; null for the widget, the form and the API. */
  label: z.string().nullable(),
  /** Set for a Meta account. */
  platform: metaPlatformSchema.nullable(),
  channel: ticketChannelSchema,
  /** Null for the API: each request names its department. */
  department: routingDepartmentRefSchema.nullable(),
  reason: routingEntryReasonSchema,
  /** False for a web form that is switched off. */
  enabled: z.boolean(),
});
export type RoutingEntryPoint = z.infer<typeof routingEntryPointSchema>;

export const routingOverviewRuleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  enabled: z.boolean(),
  actions: z.array(ruleActionSchema),
});
export type RoutingOverviewRule = z.infer<typeof routingOverviewRuleSchema>;

export const routingDepartmentAssignmentSchema = z.object({
  department: routingDepartmentRefSchema,
  mode: assignmentModeSchema,
  loadCap: z.int().nullable(),
  /** People who could be picked: may work the department and are in its rotation. */
  peopleInRotation: z.int().nonnegative(),
});
export type RoutingDepartmentAssignment = z.infer<typeof routingDepartmentAssignmentSchema>;

export const routingOverviewSchema = z.object({
  entryPoints: z.array(routingEntryPointSchema),
  /** Every rule on *Ticket created*, in the order they run. */
  rules: z.array(routingOverviewRuleSchema),
  /** The enabled rules that queue AI triage. */
  triageRules: z.array(z.object({ id: z.uuid(), name: z.string() })),
  assignment: z.array(routingDepartmentAssignmentSchema),
});
export type RoutingOverview = z.infer<typeof routingOverviewSchema>;

// --------------------------------------------------------------------------
// Test routing
// --------------------------------------------------------------------------

export const ROUTING_TEST_FROM_MAX = 320;
export const ROUTING_TEST_NAME_MAX = 200;
export const ROUTING_TEST_SUBJECT_MAX = 500;
export const ROUTING_TEST_MESSAGE_MAX = 10_000;

export const routingTestLanguageSchema = z.enum(['auto', 'en', 'ar']);
export type RoutingTestLanguage = z.infer<typeof routingTestLanguageSchema>;

export const routingTestRequestSchema = z
  .object({
    entry: routingEntryKindSchema,
    /** The mailbox, bot or Meta account; null for the others. */
    entryId: z.uuid().nullable(),
    /** An API key names its department in each request. */
    departmentId: z.uuid().optional(),
    /** An address, or the chat or customer id the channel knows the sender by. */
    from: z.string().trim().max(ROUTING_TEST_FROM_MAX).default(''),
    fromName: z.string().trim().max(ROUTING_TEST_NAME_MAX).default(''),
    subject: z.string().trim().max(ROUTING_TEST_SUBJECT_MAX).default(''),
    message: z.string().max(ROUTING_TEST_MESSAGE_MAX).default(''),
    language: routingTestLanguageSchema.default('auto'),
  })
  .superRefine((request, context) => {
    const needsId =
      request.entry === 'mailbox' ||
      request.entry === 'telegram_bot' ||
      request.entry === 'meta_account';
    if (needsId !== (request.entryId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['entryId'],
        message: needsId
          ? 'this entry point is one of the brand’s mailboxes, bots or accounts'
          : 'this entry point has no id',
      });
    }
    if ((request.entry === 'api_key') !== (request.departmentId !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['departmentId'],
        message: 'only an API request names its department',
      });
    }
  });
export type RoutingTestRequest = z.input<typeof routingTestRequestSchema>;
/** The request after defaults are applied: what the api works with. */
export type RoutingTestInput = z.output<typeof routingTestRequestSchema>;

/** What the sender check found. `automated` and `blocked` file no ticket. */
export const routingTestVerdictSchema = z.enum(['ticket', 'blocked', 'automated']);
export type RoutingTestVerdict = z.infer<typeof routingTestVerdictSchema>;

/** A team or a person the walk named; both exist, so there is always a name. */
export const routingTestNamedSchema = z.object({ id: z.uuid(), name: z.string() });

export const routingTestContactSchema = z.discriminatedUnion('kind', [
  /** A contact the sender's identifier belongs to. Only the name leaves the server. */
  z.object({ kind: z.literal('matched'), name: z.string(), matchedBy: z.string() }),
  /** `name` is what the sample gave, if anything. */
  z.object({ kind: z.literal('new'), name: z.string().nullable() }),
]);
export type RoutingTestContact = z.infer<typeof routingTestContactSchema>;

export const routingTestRuleSchema = z.object({
  ruleId: z.uuid(),
  name: z.string(),
  matched: z.boolean(),
  groups: z.array(groupTraceSchema),
  /** Empty unless the rule matched. */
  actions: z.array(actionOutcomeSchema),
  /** The rules this rule's changes could set off one level on. */
  followOns: z.array(ruleTestFollowOnSchema),
});
export type RoutingTestRule = z.infer<typeof routingTestRuleSchema>;

export const routingTestSlaSchema = z.object({
  policy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** Null with no policy, or when the ticket would not run a clock. */
  firstResponseDueAt: z.iso.datetime().nullable(),
});
export type RoutingTestSla = z.infer<typeof routingTestSlaSchema>;

export const routingTestAssignmentSchema = z.discriminatedUnion('kind', [
  /** A rule named the assignee; the rotation is not asked. */
  z.object({ kind: z.literal('rule'), assignee: routingTestNamedSchema }),
  /** The department hands nothing out. */
  z.object({ kind: z.literal('manual') }),
  z.object({
    kind: z.literal('picked'),
    mode: assignmentModeSchema,
    assignee: routingTestNamedSchema,
  }),
  /** Somebody could take it, but nobody who could is online. */
  z.object({ kind: z.literal('nobody_online'), mode: assignmentModeSchema }),
  /** Nobody is in rotation, or everybody who is has reached the cap. */
  z.object({ kind: z.literal('nobody_eligible'), mode: assignmentModeSchema }),
  /** The ticket would end in a department outside the reader's scope. */
  z.object({ kind: z.literal('out_of_scope') }),
]);
export type RoutingTestAssignment = z.infer<typeof routingTestAssignmentSchema>;

export const routingTestEntrySchema = z.object({
  entry: routingEntryKindSchema,
  label: z.string().nullable(),
  channel: ticketChannelSchema,
  department: routingDepartmentRefSchema,
  reason: routingEntryReasonSchema,
});
export type RoutingTestEntry = z.infer<typeof routingTestEntrySchema>;

/** The ticket as the rules would leave it. */
export const routingTestTicketSchema = z.object({
  department: routingDepartmentRefSchema,
  team: routingTestNamedSchema.nullable(),
  priority: ticketPrioritySchema,
  tagNames: z.array(z.string()),
});
export type RoutingTestTicket = z.infer<typeof routingTestTicketSchema>;

export const routingTestResultSchema = z.object({
  entry: routingTestEntrySchema,
  verdict: routingTestVerdictSchema,
  /** The block-list entry or the reason mail counts as automated is not shown, only that it did. */
  contact: routingTestContactSchema.nullable(),
  /** Empty unless a ticket would be created. */
  rules: z.array(routingTestRuleSchema),
  ticket: routingTestTicketSchema.nullable(),
  triage: z.enum(['queued', 'not_queued']).nullable(),
  sla: routingTestSlaSchema.nullable(),
  assignment: routingTestAssignmentSchema.nullable(),
});
export type RoutingTestResult = z.infer<typeof routingTestResultSchema>;
