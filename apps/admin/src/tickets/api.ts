import type {
  AssignableAgentList,
  MarkSpamRequest,
  MessageCreateRequest,
  Ticket,
  TicketActivityList,
  TicketCcRequest,
  TicketChannel,
  TicketCreateRequest,
  TicketDetail,
  TicketLifecycleRefusal,
  TicketList,
  TicketMergeRequest,
  TicketMergeResult,
  TicketMessage,
  TicketMessagePage,
  TicketParticipantList,
  TicketPriority,
  TicketSort,
  TicketSortDirection,
  TicketSpamSender,
  TicketSplitRequest,
  TicketStatusList,
  TicketSystemState,
  TicketUpdateRequest,
  TicketView,
  TicketViewCountList,
  TicketViewCreateInput,
  TicketViewList,
  TicketViewUpdateInput,
  TimeEntryCreateRequest,
  TimeEntryList,
} from '@helpdock/schemas';

/**
 * Everything the ticket workspace needs, and nothing else.
 * `MockTicketsApi` is the fixture the unit tests and the mock Playwright
 * projects run against; `HttpTicketsApi` is the real service (M1-02, M1-03).
 *
 * The shape mirrors `ContactsApi`: one interface, two adapters, DTOs that are
 * the very schemas `apps/api` declares its responses with.
 *
 * **"Not found" has no error of its own,** unlike the refusals of staff and
 * contacts, and that is the point rather than an omission. DOMAIN-RULES §1.2
 * requires it to be unreadable: a ticket in another department answers 404 by
 * id, by cursor and by activity alike, and "not found" must not be
 * distinguishable from "not yours". So it crosses as whatever the transport
 * threw and every screen draws the same sentence. The one exception is a rule
 * a person can act on — a merged ticket, a closed unmerge window — which is
 * {@link TicketLifecycleError} below.
 */
export interface TicketsApi {
  /** The brand's statuses: the picker's options and what a badge is drawn from. */
  statuses(brandId: string): Promise<TicketStatusList>;
  list(brandId: string, query?: TicketQuery): Promise<TicketList>;
  ticket(brandId: string, ticketId: string): Promise<TicketDetail>;
  /** The catch-up read of DOMAIN-RULES §7: everything after a `seq`. */
  messages(brandId: string, ticketId: string, after?: number): Promise<TicketMessagePage>;
  activity(brandId: string, ticketId: string): Promise<TicketActivityList>;

  create(brandId: string, request: TicketCreateRequest): Promise<TicketDetail>;
  update(brandId: string, ticketId: string, request: TicketUpdateRequest): Promise<Ticket>;
  reply(brandId: string, ticketId: string, request: MessageCreateRequest): Promise<TicketMessage>;

  // ---------------------------------------------------------------- M1-11

  /** What the "Mark as spam" dialog reads before it opens. */
  spamSender(brandId: string, ticketId: string): Promise<TicketSpamSender>;
  /** Moves the ticket to Spam and, when asked, blocks its sender in the same transaction. */
  markSpam(brandId: string, ticketId: string, request: MarkSpamRequest): Promise<Ticket>;
  /** "Not spam": back to the brand's default open status. */
  unmarkSpam(brandId: string, ticketId: string): Promise<Ticket>;

  /**
   * M1-07: who the assignee picker may offer for a ticket in this department —
   * names, presence and load, and nothing an Agent's permission does not cover.
   */
  assignable(brandId: string, departmentId: string): Promise<AssignableAgentList>;

  /** M1-13: the contact, the CCs and the staff of a ticket (DOMAIN-RULES §2.5). */
  participants(brandId: string, ticketId: string): Promise<TicketParticipantList>;
  addCc(
    brandId: string,
    ticketId: string,
    request: TicketCcRequest,
  ): Promise<TicketParticipantList>;
  removeCc(
    brandId: string,
    ticketId: string,
    participantId: string,
  ): Promise<TicketParticipantList>;

  /** M1-12's Time card. Every write answers with the whole list and its total. */
  timeEntries(brandId: string, ticketId: string): Promise<TimeEntryList>;
  logTime(
    brandId: string,
    ticketId: string,
    request: TimeEntryCreateRequest,
  ): Promise<TimeEntryList>;
  deleteTimeEntry(brandId: string, ticketId: string, entryId: string): Promise<TimeEntryList>;

  /** M1-09. Closes `ticketId` into `request.primaryTicketId` (DOMAIN-RULES §2.4). */
  merge(brandId: string, ticketId: string, request: TicketMergeRequest): Promise<TicketMergeResult>;
  /** M1-09. Undoes the merge of `ticketId`, inside its 24 hours. */
  unmerge(brandId: string, ticketId: string): Promise<TicketMergeResult>;
  /** M1-09. Copies messages of `ticketId` onto a new ticket, and answers with it. */
  split(brandId: string, ticketId: string, request: TicketSplitRequest): Promise<TicketDetail>;

  // ---------------------------------------------------------------- M1-05

  /** The views the reader may see: shared ones first, then their own. */
  views(brandId: string): Promise<TicketViewList>;
  /** One capped count per view in the sidebar. */
  viewCounts(brandId: string): Promise<TicketViewCountList>;
  createView(brandId: string, request: TicketViewCreateInput): Promise<TicketView>;
  updateView(brandId: string, viewId: string, request: TicketViewUpdateInput): Promise<TicketView>;
  deleteView(brandId: string, viewId: string): Promise<void>;
  /** Some views in a new order: all shared, or all the reader's own. */
  reorderViews(brandId: string, viewIds: readonly string[]): Promise<TicketViewList>;
}

/**
 * A transition DOMAIN-RULES §2.2 or §2.4 has no row for (M1-08, M1-09): the
 * ticket is merged, the merge window has closed, the primary was itself
 * merged. Unlike "not found", these are rules a person can act on, so the
 * `reason` picks a translated sentence — the same arrangement `TicketingError`
 * has for the settings screens.
 */
export class TicketLifecycleError extends Error {
  readonly reason: TicketLifecycleRefusal;

  constructor(reason: TicketLifecycleRefusal) {
    super(`ticket: ${reason}`);
    this.name = 'TicketLifecycleError';
    this.reason = reason;
  }
}

export const isTicketLifecycleError = (error: unknown): error is TicketLifecycleError =>
  error instanceof TicketLifecycleError;

/**
 * What a list asks for. It is the request side of `ticketListQuerySchema` with
 * every default left off: the api applies `sort`, `direction` and `limit`, and
 * a client that repeated them would be a second place they could disagree.
 *
 * Every repeatable filter is an array, because `status=a&status=b` is what a
 * query string makes of one, and `assigneeId` carries `'unassigned'` as a value
 * rather than a flag of its own so that "mine or nobody's" cannot be asked for
 * twice in one request.
 */
export interface TicketQuery {
  readonly statusId?: readonly string[];
  readonly systemState?: readonly TicketSystemState[];
  readonly priority?: readonly TicketPriority[];
  readonly departmentId?: readonly string[];
  readonly channel?: readonly TicketChannel[];
  /** People, `unassigned`, or `me` — the reader, resolved by the api (M1-05). */
  readonly assigneeId?: readonly string[];
  /** All-of: a ticket matches when it carries every tag named (M1-06). */
  readonly tagIds?: readonly string[];
  /** Only tickets whose SLA has run out (M1-05). */
  readonly overdue?: boolean;
  /** Free text over the subject: full text first, trigram for the misspelled. */
  readonly q?: string;
  readonly sort?: TicketSort;
  readonly direction?: TicketSortDirection;
  /** Opaque, from the previous page's `nextCursor`. Keyset, never an offset. */
  readonly cursor?: string;
  readonly limit?: number;
}
