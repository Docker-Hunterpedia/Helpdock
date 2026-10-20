import { z } from 'zod';
import { assignmentModeSchema } from './assignment.js';
import { importSourceSchema } from './import.js';
import { ticketChannelSchema, ticketPrioritySchema } from './ticket.js';

/**
 * M14-08: how a ticket arrived, and the "How it got here" trail built from it
 * (DOMAIN-RULES §2.8).
 *
 * The arrival is written once, into the creation activity's `to.arrival`, by
 * every path that files a ticket. Nothing new is stored: the trail is read
 * back from the activity log under the ticket's own department policy.
 */

/** The door a ticket came in through. */
export const ticketArrivalEntrySchema = z.enum([
  'mailbox',
  'widget',
  'web_form',
  'telegram_bot',
  'meta_account',
  'api_key',
  'staff',
  'import',
]);
export type TicketArrivalEntry = z.infer<typeof ticketArrivalEntrySchema>;

/**
 * Why the ticket landed in the department it did.
 *
 * - `entry_department`: the mailbox's, bot's, account's or form's own department.
 * - `brand_first_department`: the widget, or a form without a department of its own.
 * - `named_by_api`: an API key named it.
 * - `chosen_by_staff`: a person chose it when filing (or splitting) the ticket.
 * - `continued_from`: a reply to a closed ticket opened this one (DOMAIN-RULES §2.3),
 *   in the closed ticket's department.
 * - `referenced_ticket`: an email named a ticket its sender is not a participant
 *   of, and was filed in that ticket's department (§4.3).
 * - `import_mapping`: an importer's department mapping placed it (M11).
 */
export const ticketArrivalReasonSchema = z.enum([
  'entry_department',
  'brand_first_department',
  'named_by_api',
  'chosen_by_staff',
  'continued_from',
  'referenced_ticket',
  'import_mapping',
]);
export type TicketArrivalReason = z.infer<typeof ticketArrivalReasonSchema>;

export const TICKET_ARRIVAL_ADDRESS_MAX = 320;

export const ticketArrivalSchema = z.object({
  entry: ticketArrivalEntrySchema,
  /**
   * The entry point's id: the mailbox, bot, Meta account, API key, staff
   * member or import run. Null for the brand's one widget and one web form,
   * which have no id of their own.
   */
  entryId: z.string().min(1).max(200).nullable(),
  /**
   * For a mailbox, the address the customer wrote to, as the inbound message
   * names it: the mailbox's own address when it is among the recipients,
   * otherwise the first recipient (an alias forwarded into the mailbox).
   */
  address: z.string().min(1).max(TICKET_ARRIVAL_ADDRESS_MAX).optional(),
  departmentId: z.uuid(),
  reason: ticketArrivalReasonSchema,
});
export type TicketArrival = z.infer<typeof ticketArrivalSchema>;

// --------------------------------------------------------------------------
// The trail
// --------------------------------------------------------------------------

/** A department as the trail names it. `name` is null when it no longer exists. */
export const routingDepartmentSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  nameAr: z.string().nullable(),
});
export type RoutingDepartment = z.infer<typeof routingDepartmentSchema>;

/** A team or a staff member. `name` is null when it no longer exists in the brand. */
export const routingNamedSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
});
export type RoutingNamed = z.infer<typeof routingNamedSchema>;

/** Where the trail starts. */
export const routingOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recorded'),
    channel: ticketChannelSchema,
    entry: ticketArrivalEntrySchema,
    address: z.string().nullable(),
    reason: ticketArrivalReasonSchema,
    department: routingDepartmentSchema,
  }),
  /** Filed before 1.1, when arrival was not recorded: only the channel is known. */
  z.object({ kind: z.literal('unrecorded'), channel: ticketChannelSchema }),
  /** Brought in by an importer, which runs no rules and assigns no one. */
  z.object({ kind: z.literal('imported'), source: importSourceSchema }),
]);
export type RoutingOrigin = z.infer<typeof routingOriginSchema>;

/** Who made an automatic change. A person's change ends the trail, so there is no person here. */
export const routingActorSchema = z.discriminatedUnion('kind', [
  /** `name` is null for a rule since deleted. */
  z.object({ kind: z.literal('rule'), ruleId: z.uuid(), name: z.string().nullable() }),
  /** A rule's AI triage action, applied by the model a moment after the rule ran. */
  z.object({ kind: z.literal('ai_triage'), ruleId: z.uuid(), name: z.string().nullable() }),
  z.object({ kind: z.literal('assignment'), mode: assignmentModeSchema.nullable() }),
  z.object({ kind: z.literal('sla') }),
  z.object({ kind: z.literal('system') }),
]);
export type RoutingActor = z.infer<typeof routingActorSchema>;

export const routingChangeSchema = z.discriminatedUnion('kind', [
  /** A department and/or team change. A key left out did not move; `team: null` cleared it. */
  z.object({
    kind: z.literal('moved'),
    department: routingDepartmentSchema.optional(),
    team: routingNamedSchema.nullable().optional(),
  }),
  z.object({
    kind: z.literal('priority'),
    from: ticketPrioritySchema.nullable(),
    to: ticketPrioritySchema,
  }),
  /** `assignee: null` is an unassignment. */
  z.object({ kind: z.literal('assigned'), assignee: routingNamedSchema.nullable() }),
]);
export type RoutingChange = z.infer<typeof routingChangeSchema>;

export const routingStepSchema = z.object({
  at: z.iso.datetime(),
  change: routingChangeSchema,
  by: routingActorSchema,
});
export type RoutingStep = z.infer<typeof routingStepSchema>;

/** Bounded so a ticket a loop of rules has bounced around cannot answer with an unbounded page. */
export const ROUTING_STEPS_MAX = 50;

export const ticketRoutingSchema = z.object({
  origin: routingOriginSchema,
  steps: z.array(routingStepSchema).max(ROUTING_STEPS_MAX),
});
export type TicketRouting = z.infer<typeof ticketRoutingSchema>;
