import { z } from 'zod';
import { ticketCsatSchema } from './csat.js';
import { ATTACHMENTS_PER_MESSAGE_CEILING, attachmentSchema } from './media.js';
import { MAX_TAGS_PER_BRAND, tagSchema } from './tags.js';
import { timeEntrySecondsSchema } from './time-entries.js';

/**
 * The wire contract for tickets and their threads (M1-02, M1-03), shared by the
 * api and by the admin app so that one declaration serves both.
 *
 * Two rules shape what is here. Responses are parsed through the output schemas
 * on the way out (ARCHITECTURE §6, step 5), so a column a later milestone adds
 * cannot leak by being returned; and requests are parsed through the input
 * schemas by a named pipe on every parameter, so a field nobody declared cannot
 * reach a handler.
 */

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------

/** The four system states of DOMAIN-RULES §2.1. Every status maps to one. */
export const ticketSystemStateSchema = z.enum(['open', 'on_hold', 'escalated', 'closed']);
export type TicketSystemState = z.infer<typeof ticketSystemStateSchema>;

/** REQUIREMENTS §4.1. The keys are fixed; the labels a brand shows are not. */
export const ticketPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const ticketChannelSchema = z.enum(['email', 'chat', 'telegram', 'form', 'api', 'manual']);
export type TicketChannel = z.infer<typeof ticketChannelSchema>;

/** The five status hues of DESIGN §2.1. A brand may recolour a status within them. */
export const statusColorSchema = z.enum(['success', 'warning', 'danger', 'info', 'escalated']);
export type StatusColor = z.infer<typeof statusColorSchema>;

export const ticketMessageKindSchema = z.enum(['public', 'note', 'system', 'ai']);
export type TicketMessageKind = z.infer<typeof ticketMessageKindSchema>;

export const messageAuthorTypeSchema = z.enum(['staff', 'contact', 'system', 'ai']);
export type MessageAuthorType = z.infer<typeof messageAuthorTypeSchema>;

/** "Who/when/via what (UI, rule, API, AI)" — REQUIREMENTS §4.1. */
export const activityViaSchema = z.enum(['ui', 'rule', 'api', 'ai', 'system']);
export type ActivityVia = z.infer<typeof activityViaSchema>;

// --------------------------------------------------------------------------
// Statuses
// --------------------------------------------------------------------------

export const ticketStatusSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(60),
  nameAr: z.string().max(60).nullable(),
  systemState: ticketSystemStateSchema,
  pausesSla: z.boolean(),
  awaitingCustomer: z.boolean(),
  isDefault: z.boolean(),
  /** Seeded with the brand; it may be renamed and recoloured, never deleted. */
  isSystem: z.boolean(),
  /**
   * Spam and Merged (DOMAIN-RULES §2.1, §2.4). A close into such a status is
   * not a resolution: no CSAT is scheduled, and reports leave the ticket out.
   */
  excludedFromReports: z.boolean(),
  /**
   * The status "Mark as spam" moves a ticket to (M1-11). One per brand.
   * Merged is excluded from reports too, so this is the only way to tell
   * "spam" from "closed and not counted"; see `isSpamStatus`.
   */
  isSpam: z.boolean(),
  sortOrder: z.int(),
  color: statusColorSchema,
});
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const ticketStatusListSchema = z.object({ statuses: z.array(ticketStatusSchema) });
export type TicketStatusList = z.infer<typeof ticketStatusListSchema>;

export const TICKET_STATUS_NAME_MAX_LENGTH = 60;
export const MAX_TICKET_STATUSES_PER_BRAND = 60;

const ticketStatusNameSchema = z.string().trim().min(1).max(TICKET_STATUS_NAME_MAX_LENGTH);

/**
 * A status a brand adds for itself (M1-08). It maps to one of the four system
 * states, because everything downstream — the SLA maths, the reports, the
 * transition table of §2.2 — is written against those four and never against a
 * name.
 *
 * `isDefault` is not here. Which status a new or reopened ticket lands in is a
 * property of the *list*, not of a row being created, so it is moved by a
 * `PATCH` on the row that is to hold it.
 */
export const ticketStatusCreateRequestSchema = z.object({
  name: ticketStatusNameSchema,
  nameAr: ticketStatusNameSchema.nullish(),
  systemState: ticketSystemStateSchema,
  pausesSla: z.boolean().default(false),
  awaitingCustomer: z.boolean().default(false),
  color: statusColorSchema,
});
export type TicketStatusCreateRequest = z.infer<typeof ticketStatusCreateRequestSchema>;

/**
 * Every field optional, and an empty body refused, for the reason
 * `ticketUpdateRequestSchema` gives.
 *
 * A **system** row accepts only `name`, `nameAr`, `color` and `isDefault`: its
 * state and its two flags are what code refers to it by, so changing them would
 * rename the concept rather than the label (`packages/db/src/ticket-statuses.ts`).
 * The api refuses the rest with `status-state-fixed` rather than ignoring it.
 */
export const ticketStatusUpdateRequestSchema = z
  .object({
    name: ticketStatusNameSchema.optional(),
    nameAr: ticketStatusNameSchema.nullable().optional(),
    systemState: ticketSystemStateSchema.optional(),
    pausesSla: z.boolean().optional(),
    awaitingCustomer: z.boolean().optional(),
    color: statusColorSchema.optional(),
    /** Only `true` is meaningful: a brand always has exactly one default. */
    isDefault: z.literal(true).optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type TicketStatusUpdateRequest = z.infer<typeof ticketStatusUpdateRequestSchema>;

/** The whole list in its new order, for the reason `departmentReorderRequestSchema` gives. */
export const ticketStatusReorderRequestSchema = z.object({
  statusIds: z.array(z.uuid()).min(1).max(MAX_TICKET_STATUSES_PER_BRAND),
});
export type TicketStatusReorderRequest = z.infer<typeof ticketStatusReorderRequestSchema>;

/**
 * What the delete confirmation asks for first: how many tickets would be moved,
 * and where to. The screen prints "Delete · 12 tickets move to Open", so it
 * needs both, and it needs them before it asks rather than after.
 */
export const ticketStatusUsageSchema = z.object({
  statusId: z.uuid(),
  ticketCount: z.int().nonnegative(),
  /** The brand's default open status, which those tickets would move to. */
  fallbackStatusId: z.uuid(),
  fallbackName: z.string().min(1),
});
export type TicketStatusUsage = z.infer<typeof ticketStatusUsageSchema>;

export const ticketStatusParamSchema = z.object({
  brandId: z.uuid(),
  statusId: z.uuid(),
});
export type TicketStatusParam = z.infer<typeof ticketStatusParamSchema>;

// --------------------------------------------------------------------------
// Lifecycle refusals
// --------------------------------------------------------------------------

/**
 * A transition DOMAIN-RULES §2.2 does not have a row for, refused with 409.
 *
 * The status alone is too coarse to turn into a sentence — "conflict" is true
 * of all three — and the ticket workspace has to say *which* rule refused, so
 * the api sends the code and the screen picks the translated copy.
 */
export const ticketLifecycleRefusalSchema = z.enum([
  /** The ticket is the secondary of a merge; its state belongs to the primary (§2.4). */
  'ticket-merged',
  /** The ticket is soft-deleted. Nothing acts on it until it is restored or purged. */
  'ticket-deleted',
  /** Reopening something that was never closed. */
  'ticket-not-closed',
  /** "Not spam" on a ticket that is not in the Spam status (M1-11). */
  'ticket-not-spam',
  // M1-09 (§2.4). A merge or split the rules have no row for.
  /** A ticket cannot be merged into itself. */
  'merge-into-self',
  /** The chosen primary is itself merged; merge into the ticket it went to. */
  'merge-into-merged',
  /** Unmerging a ticket that is not merged. */
  'ticket-not-merged',
  /** The 24 hours in which a merge can be undone have passed. */
  'merge-window-closed',
  /** A message to split still has an attachment the media pipeline is working on. */
  'attachments-in-flight',
  /** Unmerging a ticket whose primary an Admin has since deleted (M1-15 part 2). */
  'merge-primary-deleted',
]);
export type TicketLifecycleRefusal = z.infer<typeof ticketLifecycleRefusalSchema>;

// --------------------------------------------------------------------------
// The ticket
// --------------------------------------------------------------------------

/** How long a subject may be. Long enough for a full email `Subject:` line. */
export const TICKET_SUBJECT_MAX = 500;
/** A single message body, after sanitising. Generous, because email bodies are. */
export const MESSAGE_BODY_MAX = 200_000;

/**
 * The least of a contact a ticket row needs: who to name. Not the contact's
 * identities — an address on every row of a list is fifty addresses nobody
 * asked to see — and not its stats, which are the contact screen's.
 */
export const ticketContactSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
});
export type TicketContact = z.infer<typeof ticketContactSchema>;

/**
 * One ticket. `number` and `prefix` travel together because `HD-1042` is what a
 * person reads and neither half means anything alone.
 *
 * The status is embedded rather than referenced: every list row draws a badge,
 * and a row that had to resolve its own status id would render before it knew
 * what colour it was.
 */
export const ticketSchema = z.object({
  id: z.uuid(),
  number: z.int().positive(),
  prefix: z.string().min(1),
  subject: z.string(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  channel: ticketChannelSchema,
  departmentId: z.uuid(),
  teamId: z.uuid().nullable(),
  assigneeId: z.uuid().nullable(),
  contactId: z.uuid().nullable(),
  parentId: z.uuid().nullable(),
  mergedIntoId: z.uuid().nullable(),
  splitFromId: z.uuid().nullable(),
  /** Filled by the SLA engine (M3-02); null until a policy applies to the ticket. */
  firstResponseDueAt: z.iso.datetime().nullable(),
  resolutionDueAt: z.iso.datetime().nullable(),
  slaBreached: z.boolean(),
  closedAt: z.iso.datetime().nullable(),
  custom: z.record(z.string(), z.unknown()),
  /**
   * The chips this ticket carries (M1-06), embedded for the reason the status
   * is: every row draws them, and a row that had to resolve its own tag ids
   * would render before it knew what it was showing.
   *
   * **Optional**, and the api always fills it. Optional because the field
   * arrived after the ticket did: a client built against the M1-02 shape, and a
   * fixture written against it, stay valid, and a renderer that has not learned
   * about tags yet draws nothing rather than crashing on `undefined`.
   */
  tags: z.array(tagSchema).optional(),
  /**
   * Who the ticket is about, by name (M1-15), for the reason the status is
   * embedded: a list row names its contact, and a row that had to page through
   * the contact list to find the name would draw most rows without one.
   *
   * The list and the ticket read fill it; the writes leave it off. It is also
   * left off for a caller without `contact:read` — an api key scoped to tickets
   * alone — who still has `contactId`. `null` means the ticket names nobody.
   */
  contact: ticketContactSchema.nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Ticket = z.infer<typeof ticketSchema>;

// --------------------------------------------------------------------------
// Messages and activity
// --------------------------------------------------------------------------

/**
 * One row of the thread. `bodyHtml` has already been through the sanitiser —
 * it is stored sanitised, so what is returned is what was stored — and
 * `bodyText` is the same message as text.
 */
export const ticketMessageSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  /** The cursor of DOMAIN-RULES §7. A client catches up from the highest it holds. */
  seq: z.int().positive(),
  /** Echoed back so a client can match the row to the send it is waiting on. */
  clientId: z.uuid().nullable(),
  kind: ticketMessageKindSchema,
  authorType: messageAuthorTypeSchema,
  authorId: z.string().nullable(),
  bodyHtml: z.string(),
  bodyText: z.string(),
  channel: ticketChannelSchema,
  /**
   * What was sent with it (M1-10). Embedded rather than referenced for the
   * reason the status is: a thread row draws a thumbnail, and a row that had to
   * resolve its own attachments would render before it knew whether there were
   * any. Empty for every message that carries none.
   */
  attachments: z.array(attachmentSchema).default([]),
  createdAt: z.iso.datetime(),
});
export type TicketMessage = z.infer<typeof ticketMessageSchema>;

/**
 * A page of the thread. `nextAfter` is the cursor to ask for next, and null
 * when the caller has reached the end — which is what a client compares against
 * its own `last_seq` after a reconnect (§7).
 */
export const ticketMessagePageSchema = z.object({
  messages: z.array(ticketMessageSchema),
  nextAfter: z.int().nonnegative().nullable(),
});
export type TicketMessagePage = z.infer<typeof ticketMessagePageSchema>;

export const ticketActivityEntrySchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  actorType: z.enum(['staff', 'visitor', 'apikey', 'system']),
  actorId: z.string(),
  action: z.string(),
  from: z.record(z.string(), z.unknown()).nullable(),
  to: z.record(z.string(), z.unknown()).nullable(),
  via: activityViaSchema,
  createdAt: z.iso.datetime(),
});
export type TicketActivityEntry = z.infer<typeof ticketActivityEntrySchema>;

export const ticketActivityListSchema = z.object({
  activity: z.array(ticketActivityEntrySchema),
});
export type TicketActivityList = z.infer<typeof ticketActivityListSchema>;

// --------------------------------------------------------------------------
// Merge and split (M1-09, DOMAIN-RULES §2.4)
// --------------------------------------------------------------------------

/** How long a merge can be undone for (DOMAIN-RULES §2.4). */
export const UNMERGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The most messages of one merged ticket the primary's thread carries inline.
 * A longer thread is read on the merged ticket itself, which stays readable.
 */
export const MERGED_MESSAGES_MAX = 100;

/** Another ticket, named from this one's thread: "Merged into HD-1038". */
export const ticketLinkSchema = z.object({
  id: z.uuid(),
  number: z.int().positive(),
  prefix: z.string().min(1),
  subject: z.string(),
});
export type TicketLink = z.infer<typeof ticketLinkSchema>;

/**
 * How a linked ticket is joined to the one being read, from the reader's side:
 * `parent` is the closed ticket this one continues (§2.3), `mergedInto` and
 * `mergedFrom` the two ends of a merge, `splitFrom` and `splitTo` the two ends
 * of a split (§2.4).
 */
export const ticketRelationSchema = z.enum([
  'parent',
  'mergedInto',
  'mergedFrom',
  'splitFrom',
  'splitTo',
]);
export type TicketRelation = z.infer<typeof ticketRelationSchema>;

/**
 * One linked ticket in the details panel (M1-15 part 2), read under the
 * caller's scope. A ticket the reader cannot open is `visible: false` and
 * carries its relation and nothing else — no id, reference, subject or status —
 * so it is indistinguishable from one that no longer exists (§1.2). Only a
 * link the read ticket itself names (`parentId`, `mergedIntoId`, `splitFromId`)
 * can come back hidden: a ticket split *from* this one into a department the
 * reader cannot see is not found at all, as the list would not find it.
 */
export const relatedTicketSchema = z.discriminatedUnion('visible', [
  ticketLinkSchema.extend({
    visible: z.literal(true),
    relation: ticketRelationSchema,
    status: ticketStatusSchema,
  }),
  z.object({ visible: z.literal(false), relation: ticketRelationSchema }),
]);
export type RelatedTicket = z.infer<typeof relatedTicketSchema>;
export type VisibleRelatedTicket = Extract<RelatedTicket, { visible: true }>;

/** When and by whom a ticket was merged, and until when that can be undone. */
const mergeFactsSchema = z.object({
  mergedAt: z.iso.datetime(),
  /** Null when the merge was not made by a staff member. */
  mergedById: z.uuid().nullable(),
  /** Null once the 24 hours have passed: the screen offers no Unmerge after that. */
  unmergeableUntil: z.iso.datetime().nullable(),
});

/**
 * A ticket merged into the one being read, with its messages inline and
 * read-only (§2.4: "messages are not moved"). Each message keeps its own
 * `ticketId`, which is how the thread marks where it came from.
 *
 * A chain — A merged into B, then B into C — is flattened: C lists A and B,
 * and `mergedIntoId` says which of them A went into.
 */
export const mergedTicketSchema = ticketLinkSchema.extend({
  ...mergeFactsSchema.shape,
  mergedIntoId: z.uuid(),
  /**
   * The system message on the primary that announced the merge, so the thread
   * draws this ticket's block where it happened. Null for a ticket merged
   * further down a chain, whose announcement is in another ticket's thread.
   */
  systemMessageId: z.uuid().nullable(),
  /** The oldest {@link MERGED_MESSAGES_MAX} messages. */
  messages: z.array(ticketMessageSchema),
  /** True when the merged ticket has more messages than are carried here. */
  hasMoreMessages: z.boolean(),
});
export type MergedTicket = z.infer<typeof mergedTicketSchema>;

/** Where the ticket being read was merged to, for the "Merged into HD-1038" banner. */
export const mergedIntoSchema = ticketLinkSchema.extend(mergeFactsSchema.shape);
export type MergedInto = z.infer<typeof mergedIntoSchema>;

/** What `GET /tickets/:ticketId` answers: the ticket and the start of its thread. */
export const ticketDetailSchema = z.object({
  ticket: ticketSchema,
  messages: ticketMessagePageSchema,
  activity: z.array(ticketActivityEntrySchema),
  /**
   * The survey for the ticket's latest close (M1-12), or null when there is
   * none — never closed, closed as spam or a merge, or closed while the brand
   * had CSAT off. Optional for the reason `ticket.tags` is.
   */
  csat: ticketCsatSchema.nullable().optional(),
  /**
   * M1-09. Optional for the reason `tags` is: a client and a fixture built
   * against the M1-02 shape stay valid. The api always fills all three.
   *
   * `merged` is every ticket merged into this one; `mergedInto` is the ticket
   * this one was merged into, or null; `related` is every ticket linked to
   * this one — its parent, both ends of a merge and both ends of a split — in
   * that order, for the details panel's Linked tickets and so a system message
   * that names one can link to it. See {@link relatedTicketSchema}.
   */
  merged: z.array(mergedTicketSchema).optional(),
  mergedInto: mergedIntoSchema.nullable().optional(),
  related: z.array(relatedTicketSchema).optional(),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

// --------------------------------------------------------------------------
// The list
// --------------------------------------------------------------------------

/**
 * How a list is ordered. `updatedAt` is the desk's default — the queue is
 * "what moved last" — and `number` is what somebody looking for one ticket
 * sorts by.
 */
export const ticketSortSchema = z.enum(['updatedAt', 'createdAt', 'number', 'priority']);
export type TicketSort = z.infer<typeof ticketSortSchema>;

export const ticketSortDirectionSchema = z.enum(['asc', 'desc']);
export type TicketSortDirection = z.infer<typeof ticketSortDirectionSchema>;

export const TICKET_PAGE_SIZE_DEFAULT = 25;
export const TICKET_PAGE_SIZE_MAX = 100;

/**
 * The list's filters. Every repeatable one is an array, and a query string
 * writes it as `status=a&status=b`; `coerceArray` below is what makes a single
 * value parse as a one-element array, because that is what a browser sends when
 * exactly one chip is selected.
 */
const coerceArray = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(item).max(50),
  );

/** The assignee filter's two values that are not a person. */
export const TICKET_ASSIGNEE_UNASSIGNED = 'unassigned';
export const TICKET_ASSIGNEE_ME = 'me';

/**
 * A boolean in a query string, parsed idempotently: the global pipe and the
 * parameter's own both parse a query, and the second is handed the boolean the
 * first produced. The same arrangement as `contactSearchQuerySchema`'s.
 */
const queryBoolean = z.union([z.boolean(), z.stringbool()]);

export const ticketListQuerySchema = z.object({
  statusId: coerceArray(z.uuid()).optional(),
  /** Filter by the four system states, for "everything still open". */
  systemState: coerceArray(ticketSystemStateSchema).optional(),
  priority: coerceArray(ticketPrioritySchema).optional(),
  departmentId: coerceArray(z.uuid()).optional(),
  channel: coerceArray(ticketChannelSchema).optional(),
  /**
   * `unassigned` is a value rather than a separate flag, because "unassigned"
   * is one of the chips in the same filter and a second parameter would let a
   * caller ask for both at once.
   *
   * `me` is the reader, resolved by the api from the principal (M1-05). A
   * saved view says `me` rather than a person's id so that one shared "My
   * open" means *mine* to everybody who opens it.
   */
  assigneeId: coerceArray(
    z.union([z.uuid(), z.literal(TICKET_ASSIGNEE_UNASSIGNED), z.literal(TICKET_ASSIGNEE_ME)]),
  ).optional(),
  /**
   * Tags, with **all-of** semantics: a ticket matches when it carries every tag
   * named, not any of them. Two chips in a filter are how somebody narrows a
   * queue, and "any" would widen it instead — the one reading that is wrong in
   * the direction that shows rows the reader asked to exclude.
   *
   * Two spellings, one filter. `tagId` is what M1-02 declared and what a query
   * string writes as `tagId=a&tagId=b`; `tagIds` is the same thing said once,
   * which is what a client assembling a saved view sends. They are merged, so
   * naming both is naming their union.
   */
  tagId: coerceArray(z.uuid()).optional(),
  tagIds: coerceArray(z.uuid()).optional(),
  /** Free text: every word of the subject and first message, with a fuzzy fallback (ADR 0011). */
  q: z.string().trim().min(1).max(200).optional(),
  /**
   * `true` keeps only tickets whose SLA has run out (M1-05's "Overdue"): not
   * closed, clock not paused, and breached or past a due time. `false` is the
   * same as leaving it off — "not overdue" is not a queue anybody works.
   */
  overdue: queryBoolean.optional(),
  sort: ticketSortSchema.default('updatedAt'),
  direction: ticketSortDirectionSchema.default('desc'),
  /** Opaque. It is the api's own encoding of "the row after this one". */
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_PAGE_SIZE_MAX).default(TICKET_PAGE_SIZE_DEFAULT),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketListSchema = z.object({
  tickets: z.array(ticketSchema),
  /** Null when this page is the last one. Opaque to the client. */
  nextCursor: z.string().nullable(),
});
export type TicketList = z.infer<typeof ticketListSchema>;

// --------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------

/**
 * Manual creation. The body is the first message of the thread, so a ticket is
 * never created empty — a ticket with no message is a row nobody can answer.
 */
export const ticketCreateRequestSchema = z
  .object({
    /**
     * Required unless a template supplies one. The three fields a ticket cannot
     * be written without — subject, body and department — are optional here and
     * checked below, because a template exists precisely to fill them.
     */
    subject: z.string().trim().min(1).max(TICKET_SUBJECT_MAX).optional(),
    /** Rich text as the composer wrote it. Sanitised by the api before it is stored. */
    bodyHtml: z.string().min(1).max(MESSAGE_BODY_MAX).optional(),
    departmentId: z.uuid().optional(),
    /** Absent means "whatever the template says", or `medium` when there is none. */
    priority: ticketPrioritySchema.optional(),
    /** M1-04 owns contacts; until then a ticket may be filed without one. */
    contactId: z.uuid().optional(),
    assigneeId: z.uuid().optional(),
    teamId: z.uuid().optional(),
    /** Defaults to `manual`, which is what a ticket typed into the admin is. */
    channel: ticketChannelSchema.default('manual'),
    /**
     * A ticket template (M1-06). The **id**, never a copy of the template: the
     * api applies it, so a template edited between the picker rendering and the
     * ticket being filed is applied as it now is, and an API client gets the
     * same behaviour without reimplementing it. Anything named beside it wins
     * over what the template says.
     */
    templateId: z.uuid().optional(),
    /** Tags to start with, on top of the template's own. */
    tagIds: z.array(z.uuid()).max(MAX_TAGS_PER_BRAND).optional(),
    /**
     * Custom field values, keyed by `custom_field_defs.key`. Validated against
     * the brand's ticket definitions: an unknown key is refused, and every
     * required field has to be present (`@helpdock/schemas/custom-fields`).
     */
    custom: z.record(z.string(), z.unknown()).optional(),
    /**
     * The `client_id` the **first message** is stored with.
     *
     * It does not make creation idempotent, and cannot: the uniqueness DOMAIN-RULES
     * §7 defines is `(conversation_id, client_id)`, and a conversation does not
     * exist until the ticket does. A retried `POST /tickets` therefore creates a
     * second ticket. What it is for is the reply path: the admin's composer holds
     * one id for the message it is sending, and the first message is a message.
     * Idempotent creation needs a key that outlives the request — M2-04's
     * threading key for email, M4's conversation id for the widget.
     */
    clientId: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.templateId !== undefined) {
      return;
    }

    for (const field of ['subject', 'bodyHtml', 'departmentId'] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Required unless the request names a template',
        });
      }
    }
  });
export type TicketCreateRequest = z.infer<typeof ticketCreateRequestSchema>;

/**
 * Every field a `PATCH` may move. All optional, and an empty body is refused by
 * the handler rather than silently succeeding, so "nothing changed" is never
 * mistaken for "it worked".
 *
 * `statusId` goes through the transition hook rather than being written
 * directly; M1-08 replaces the hook with the state machine of DOMAIN-RULES §2.2.
 */
export const ticketUpdateRequestSchema = z.object({
  subject: z.string().trim().min(1).max(TICKET_SUBJECT_MAX).optional(),
  priority: ticketPrioritySchema.optional(),
  departmentId: z.uuid().optional(),
  teamId: z.uuid().nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  statusId: z.uuid().optional(),
  /**
   * Custom field values to write over the stored ones (M1-06). A **patch**: a
   * key that is absent is left alone and a key set to `null` is cleared, so
   * `required` is not enforced here — a request that names two fields says
   * nothing about the other eight.
   *
   * Tags are not here. They are replaced as a set through
   * `PUT /tickets/:ticketId/tags`, which writes its own activity row.
   */
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type TicketUpdateRequest = z.infer<typeof ticketUpdateRequestSchema>;

/**
 * A reply or a note. `kind` is the one field that decides whether this leaves
 * the building, so it is required rather than defaulted: a note posted as a
 * public reply by an omitted default is the worst bug this endpoint could have.
 */
export const messageCreateRequestSchema = z.object({
  kind: z.enum(['public', 'note']),
  bodyHtml: z.string().min(1).max(MESSAGE_BODY_MAX),
  /**
   * DOMAIN-RULES §7: "Every message has a client-generated `client_id`
   * (UUIDv7)… `(conversation_id, client_id)` is unique, so retries are
   * deduplicated." Optional on the wire because the API and channel adapters
   * have their own keys, but the admin always sends one.
   */
  clientId: z.uuid().optional(),
  /**
   * Attachments to send with it (M1-10), each already presigned, uploaded and
   * confirmed against **this** ticket by **this** principal. The api links them
   * in the same transaction as the message, and refuses the whole send if any
   * one of them cannot be linked — a message that quietly dropped a file is a
   * message somebody believes they sent with it.
   *
   * The ceiling here is the schema's; the real limit is the brand's
   * `maxAttachmentsPerMessage` and is enforced by the handler, because a policy
   * is per brand and a schema is not.
   */
  attachmentIds: z.array(z.uuid()).max(ATTACHMENTS_PER_MESSAGE_CEILING).optional(),
  /**
   * The per-reply timer (M1-12): time spent on this reply, logged as a time
   * entry in the same transaction as the message. Ignored when the brand has
   * time tracking off — the reply is what the agent meant to send, and it is
   * not refused over the timer that ran beside it.
   */
  timeSpentSeconds: timeEntrySecondsSchema.optional(),
});
export type MessageCreateRequest = z.infer<typeof messageCreateRequestSchema>;

export const messagePageQuerySchema = z.object({
  /** Return messages with `seq` greater than this (DOMAIN-RULES §7). */
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(TICKET_PAGE_SIZE_MAX).default(TICKET_PAGE_SIZE_DEFAULT),
});
export type MessagePageQuery = z.infer<typeof messagePageQuerySchema>;

// --------------------------------------------------------------------------
// Path parameters
// --------------------------------------------------------------------------

export const ticketParamSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
});
export type TicketParam = z.infer<typeof ticketParamSchema>;
