import type {
  MarkSpamRequest,
  MessageCreateRequest,
  Ticket,
  TicketActivityList,
  TicketChannel,
  TicketCreateRequest,
  TicketDetail,
  TicketList,
  TicketMessage,
  TicketMessagePage,
  TicketPriority,
  TicketSort,
  TicketSortDirection,
  TicketSpamSender,
  TicketStatusList,
  TicketSystemState,
  TicketUpdateRequest,
} from '@helpdock/schemas';

/**
 * Everything the ticket workspace needs, and nothing else.
 * `MockTicketsApi` is the fixture the unit tests and the mock Playwright
 * projects run against; `HttpTicketsApi` is the real service (M1-02, M1-03).
 *
 * The shape mirrors `ContactsApi`: one interface, two adapters, DTOs that are
 * the very schemas `apps/api` declares its responses with.
 *
 * **There is no `TicketError`,** unlike staff and contacts, and that is the
 * point rather than an omission. The refusals those two have are rules a person
 * can act on — "that address is taken", "that is the last identifier". A ticket
 * has one refusal, and DOMAIN-RULES §1.2 requires it to be unreadable: a ticket
 * in another department answers 404 by id, by cursor and by activity alike, and
 * "not found" must not be distinguishable from "not yours". So every failure
 * crosses as whatever the transport threw and every screen draws the same
 * sentence.
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
}

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
  readonly assigneeId?: readonly (string | 'unassigned')[];
  /** Free text over the subject: full text first, trigram for the misspelled. */
  readonly q?: string;
  readonly sort?: TicketSort;
  readonly direction?: TicketSortDirection;
  /** Opaque, from the previous page's `nextCursor`. Keyset, never an offset. */
  readonly cursor?: string;
  readonly limit?: number;
}
