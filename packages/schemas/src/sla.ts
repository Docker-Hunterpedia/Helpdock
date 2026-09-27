import { z } from 'zod';

/**
 * SLA policies and the clocks they run (M3-02, DOMAIN-RULES §3).
 *
 * This file imports nothing from `ticket.ts`, because `ticket.ts` embeds the
 * SLA summary in every ticket and an import cycle between two modules of
 * `const` schemas is a temporal-dead-zone error waiting for the first reorder.
 * The priority list is therefore spelled once more here; `sla.test.ts` proves
 * it is the same list as `ticketPrioritySchema`.
 */

const priorityValues = ['low', 'medium', 'high', 'urgent'] as const;
const slaPrioritySchema = z.enum(priorityValues);
export const SLA_PRIORITIES = priorityValues;

// --------------------------------------------------------------------------
// Clocks
// --------------------------------------------------------------------------

/**
 * The three clocks of §3.1 and §3.5. A ticket runs at most two at once: a
 * response clock (first response, or next response after a reopen) and the
 * resolution clock.
 */
export const slaClockKindSchema = z.enum(['first_response', 'next_response', 'resolution']);
export type SlaClockKind = z.infer<typeof slaClockKindSchema>;

/**
 * What the SLA card and the list's SlaTimer draw (artboard `Admin/Ticket-SLA`):
 * the worst clock still counting decides. `warning` is "an escalation step
 * fired, or under 20 % is left"; `none` is "no policy applies".
 */
export const slaStateSchema = z.enum(['running', 'warning', 'paused', 'breached', 'met', 'none']);
export type SlaState = z.infer<typeof slaStateSchema>;

/** Under this share of the target left, a running clock is drawn as a warning. */
export const SLA_WARNING_FRACTION = 0.2;

/** How the policy counts time: inside business hours, or every minute (24/7). */
export const slaTimeModeSchema = z.enum(['business', 'calendar']);
export type SlaTimeMode = z.infer<typeof slaTimeModeSchema>;

/** One step that has run, kept on the clock so it never runs twice (§3.4). */
export const slaFiredStepSchema = z.object({
  percent: z.int().positive(),
  firedAt: z.iso.datetime(),
});
export type SlaFiredStep = z.infer<typeof slaFiredStepSchema>;

// --------------------------------------------------------------------------
// Escalation
// --------------------------------------------------------------------------

export const slaNotifyRecipientSchema = z.discriminatedUnion('kind', [
  /** The Team Leaders of the ticket's department. */
  z.object({ kind: z.literal('department_leads') }),
  z.object({ kind: z.literal('team'), teamId: z.uuid() }),
  z.object({ kind: z.literal('user'), userId: z.uuid() }),
]);
export type SlaNotifyRecipient = z.infer<typeof slaNotifyRecipientSchema>;

/** The actions of §3.4: notify, reassign, raise priority, add tag, set status Escalated. */
export const slaActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notify'), recipient: slaNotifyRecipientSchema }),
  z.object({ type: z.literal('reassign'), userId: z.uuid() }),
  z.object({ type: z.literal('raise_priority') }),
  z.object({ type: z.literal('add_tag'), tagId: z.uuid() }),
  z.object({ type: z.literal('set_escalated') }),
]);
export type SlaAction = z.infer<typeof slaActionSchema>;

/** 100 % is the breach. A step may sit above it and run after the breach (§3.4). */
export const SLA_BREACH_PERCENT = 100;
export const SLA_STEP_PERCENT_MAX = 1_000;
export const SLA_STEPS_MAX = 10;
export const SLA_STEP_ACTIONS_MAX = 5;

export const slaEscalationStepSchema = z.object({
  atPercent: z.int().min(1).max(SLA_STEP_PERCENT_MAX),
  actions: z.array(slaActionSchema).min(1).max(SLA_STEP_ACTIONS_MAX),
});
export type SlaEscalationStep = z.infer<typeof slaEscalationStepSchema>;

const escalationSchema = z
  .array(slaEscalationStepSchema)
  .max(SLA_STEPS_MAX)
  .refine(
    (steps) => new Set(steps.map((step) => step.atPercent)).size === steps.length,
    'Two steps run at the same percent',
  );

// --------------------------------------------------------------------------
// Policies
// --------------------------------------------------------------------------

const operatorSchema = z.enum(['any', 'none']);

/** "Department is any of Billing, Returns" and "Priority is none of Low". */
export const slaConditionSchema = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('department'),
    operator: operatorSchema,
    values: z.array(z.uuid()).min(1).max(100),
  }),
  z.object({
    field: z.literal('priority'),
    operator: operatorSchema,
    values: z.array(slaPrioritySchema).min(1).max(priorityValues.length),
  }),
]);
export type SlaCondition = z.infer<typeof slaConditionSchema>;

const conditionsSchema = z
  .array(slaConditionSchema)
  .max(2)
  .refine(
    (conditions) =>
      new Set(conditions.map((condition) => condition.field)).size === conditions.length,
    'One condition per field',
  );

/** A year, in minutes: a target longer than that is not a service level. */
export const SLA_TARGET_MINUTES_MAX = 525_600;

export const slaTargetSchema = z.object({
  firstResponseMinutes: z.int().min(1).max(SLA_TARGET_MINUTES_MAX),
  resolutionMinutes: z.int().min(1).max(SLA_TARGET_MINUTES_MAX),
});
export type SlaTarget = z.infer<typeof slaTargetSchema>;

export const slaTargetsSchema = z.object({
  low: slaTargetSchema,
  medium: slaTargetSchema,
  high: slaTargetSchema,
  urgent: slaTargetSchema,
});
export type SlaTargets = z.infer<typeof slaTargetsSchema>;

export const SLA_POLICY_NAME_MAX = 120;
export const SLA_POLICIES_MAX = 50;

const policyBodySchema = z.object({
  name: z.string().trim().min(1).max(SLA_POLICY_NAME_MAX),
  conditions: conditionsSchema,
  timeMode: slaTimeModeSchema,
  targets: slaTargetsSchema,
  escalation: escalationSchema,
});

export const slaPolicyCreateRequestSchema = policyBodySchema;
export type SlaPolicyCreateRequest = z.infer<typeof slaPolicyCreateRequestSchema>;

/** The editor saves the whole policy, as the screen holds the whole policy. */
export const slaPolicyUpdateRequestSchema = policyBodySchema;
export type SlaPolicyUpdateRequest = z.infer<typeof slaPolicyUpdateRequestSchema>;

export const slaPolicyReorderRequestSchema = z.object({
  policyIds: z.array(z.uuid()).min(1).max(SLA_POLICIES_MAX),
});
export type SlaPolicyReorderRequest = z.infer<typeof slaPolicyReorderRequestSchema>;

export const slaPolicyParamSchema = z.object({ brandId: z.uuid(), policyId: z.uuid() });
export type SlaPolicyParam = z.infer<typeof slaPolicyParamSchema>;

export const slaPolicySchema = policyBodySchema.extend({
  id: z.uuid(),
  name: z.string(),
  /** Zero-based; the first policy whose conditions match applies. */
  position: z.int().nonnegative(),
  /** Open tickets whose clocks this policy runs; what a save recomputes. */
  runningTickets: z.int().nonnegative(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type SlaPolicy = z.infer<typeof slaPolicySchema>;

export const slaPolicyListSchema = z.object({ policies: z.array(slaPolicySchema) });
export type SlaPolicyList = z.infer<typeof slaPolicyListSchema>;

/**
 * "For every policy": the two brand settings of the SLAs tab. A route of its
 * own for the reason the reply behaviour has one — a Team Leader may change
 * these, and the whole-brand `PATCH` is Admin-only.
 */
export const slaSettingsUpdateRequestSchema = z
  .object({
    aiCountsAsFirstResponse: z.boolean().optional(),
    slaCountReopens: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type SlaSettingsUpdateRequest = z.infer<typeof slaSettingsUpdateRequestSchema>;

// --------------------------------------------------------------------------
// What a ticket carries
// --------------------------------------------------------------------------

/**
 * The list row's SlaTimer: one clock, already judged. `remainingMs` is
 * business time left at the moment of the read (negative once breached), so a
 * row does not have to know the calendar to print "1h 20m".
 */
export const ticketSlaSummarySchema = z.object({
  state: slaStateSchema,
  clock: slaClockKindSchema,
  remainingMs: z.int(),
  breachedAt: z.iso.datetime().nullable(),
  /** The response clock is a next-response clock: the ticket was reopened (§3.5). */
  reopened: z.boolean(),
});
export type TicketSlaSummary = z.infer<typeof ticketSlaSummarySchema>;

export const ticketSlaClockSchema = z.object({
  kind: slaClockKindSchema,
  targetMinutes: z.int().positive(),
  startedAt: z.iso.datetime(),
  /** Null while paused, and once the clock is satisfied or stopped. */
  dueAt: z.iso.datetime().nullable(),
  satisfiedAt: z.iso.datetime().nullable(),
  breachedAt: z.iso.datetime().nullable(),
  pausedAt: z.iso.datetime().nullable(),
  stoppedAt: z.iso.datetime().nullable(),
  /** Business time consumed at the moment of the read. */
  elapsedMs: z.int().nonnegative(),
  firedSteps: z.array(slaFiredStepSchema),
});
export type TicketSlaClock = z.infer<typeof ticketSlaClockSchema>;

/** The DetailsPanel SLA card: every state of artboard `Admin/Ticket-SLA`. */
export const ticketSlaSchema = z.object({
  state: slaStateSchema,
  policyId: z.uuid().nullable(),
  policyName: z.string().nullable(),
  timeMode: slaTimeModeSchema.nullable(),
  /** The current clocks, response first. Empty when no policy applies. */
  clocks: z.array(ticketSlaClockSchema),
  /** The step that ran last, with what it did, for "75 % step ran 09:30". */
  lastStep: z
    .object({
      clock: slaClockKindSchema,
      percent: z.int().positive(),
      firedAt: z.iso.datetime(),
      actions: z.array(slaActionSchema),
    })
    .nullable(),
  reopenedAt: z.iso.datetime().nullable(),
  /** How the initial response clock ended, kept for reports after a reopen (§3.5). */
  initialResponse: z.enum(['met', 'breached']).nullable(),
});
export type TicketSla = z.infer<typeof ticketSlaSchema>;

// --------------------------------------------------------------------------
// Outbox events other milestones consume
// --------------------------------------------------------------------------

export const SLA_EVENTS = {
  warning: 'sla.warning',
  breached: 'sla.breached',
  escalated: 'ticket.escalated',
} as const;

/**
 * Who a step's `notify` actions named, carried flat on the event for M3-07:
 * the people, the teams (each member by their own settings), and whether the
 * Team Leaders of the ticket's department were named. Absent when the step
 * named nobody, and the notification goes to whoever holds the ticket.
 */
export const slaNotifySchema = z.object({
  userIds: z.array(z.uuid()),
  teamIds: z.array(z.uuid()),
  departmentLeads: z.boolean(),
});
export type SlaNotify = z.infer<typeof slaNotifySchema>;

/** `sla.warning`: a step below 100 % ran. */
export const slaWarningEventSchema = z.object({
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  clock: slaClockKindSchema,
  stepPercent: z.int().positive(),
  ...slaNotifySchema.partial().shape,
});
export type SlaWarningEvent = z.infer<typeof slaWarningEventSchema>;

/** `sla.breached`: recorded once per clock (§3.4). */
export const slaBreachedEventSchema = z.object({
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  clock: slaClockKindSchema,
  /** `timer` when the due time passed; `change` when a recompute used the target up (§3.3). */
  cause: z.enum(['timer', 'change']),
});
export type SlaBreachedEvent = z.infer<typeof slaBreachedEventSchema>;

/** `ticket.escalated`: a step at or past the breach ran, or a step set status Escalated. */
export const ticketEscalatedEventSchema = slaWarningEventSchema;
export type TicketEscalatedEvent = SlaWarningEvent;
