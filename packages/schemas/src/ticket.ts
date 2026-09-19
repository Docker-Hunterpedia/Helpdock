import { z } from 'zod';

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
  sortOrder: z.int(),
  color: statusColorSchema,
});
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const ticketStatusListSchema = z.object({ statuses: z.array(ticketStatusSchema) });
export type TicketStatusList = z.infer<typeof ticketStatusListSchema>;

// --------------------------------------------------------------------------
// The ticket
// --------------------------------------------------------------------------

/** How long a subject may be. Long enough for a full email `Subject:` line. */
export const TICKET_SUBJECT_MAX = 500;
/** A single message body, after sanitising. Generous, because email bodies are. */
export const MESSAGE_BODY_MAX = 200_000;

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

/** What `GET /tickets/:ticketId` answers: the ticket and the start of its thread. */
export const ticketDetailSchema = z.object({
  ticket: ticketSchema,
  messages: ticketMessagePageSchema,
  activity: z.array(ticketActivityEntrySchema),
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
   */
  assigneeId: coerceArray(z.union([z.uuid(), z.literal('unassigned')])).optional(),
  /** M1-06 owns `tags`. Declared here so the list's shape does not change under the UI. */
  tagId: coerceArray(z.uuid()).optional(),
  /** Free text over the subject: full-text first, trigram for the misspelled. */
  q: z.string().trim().min(1).max(200).optional(),
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
export const ticketCreateRequestSchema = z.object({
  subject: z.string().trim().min(1).max(TICKET_SUBJECT_MAX),
  /** Rich text as the composer wrote it. Sanitised by the api before it is stored. */
  bodyHtml: z.string().min(1).max(MESSAGE_BODY_MAX),
  departmentId: z.uuid(),
  priority: ticketPrioritySchema.default('medium'),
  /** M1-04 owns contacts; until then a ticket may be filed without one. */
  contactId: z.uuid().optional(),
  assigneeId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  /** Defaults to `manual`, which is what a ticket typed into the admin is. */
  channel: ticketChannelSchema.default('manual'),
  /** The first message's dedupe key, exactly as a reply's (DOMAIN-RULES §7). */
  clientId: z.uuid().optional(),
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
