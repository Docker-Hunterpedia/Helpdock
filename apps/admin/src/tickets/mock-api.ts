import type {
  Attachment,
  MergedTicket,
  MessageCreateRequest,
  Ticket,
  TicketActivityEntry,
  TicketActivityList,
  TicketCreateRequest,
  TicketDetail,
  TicketLink,
  TicketList,
  TicketMergeRequest,
  TicketMergeResult,
  TicketMessage,
  TicketMessagePage,
  TicketPriority,
  TicketSplitRequest,
  TicketStatus,
  TicketStatusList,
  TicketUpdateRequest,
} from '@helpdock/schemas';
import { TICKET_PAGE_SIZE_DEFAULT, UNMERGE_WINDOW_MS } from '@helpdock/schemas';
import {
  MOCK_CONTACT_ACCOUNT,
  MOCK_CONTACT_ARABIC,
  MOCK_CONTACT_GMAIL,
  MOCK_CONTACT_MONA,
  MOCK_CONTACT_VISITOR,
} from '../contacts/mock-api.js';
import type { MockAttachmentUploader } from '../media/mock-uploader.js';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../staff/mock-api.js';
import { TicketLifecycleError, type TicketQuery, type TicketsApi } from './api.js';

/**
 * The fixture the ticket workspace runs against until an install is in front of
 * it, and the one the browser suite drives.
 *
 * It is the whole of `TicketsApi` rather than a stub of it: the filters, the
 * keyset cursor, the `?after=` catch-up and the `clientId` de-duplication all
 * behave the way M1-02 and M1-03 behave, because the screens are built on
 * exactly those behaviours and a fixture that faked them would let a screen
 * that only works against a fake reach a browser.
 *
 * **Every timestamp is relative to when the fixture was built**, not to a fixed
 * date. A breached SLA has to still read "breached 2h" next month, and a thread
 * dated September 2026 would read as ancient by the time somebody clones this.
 * The screenshot suite fixes the browser clock, so the pictures stay stable.
 *
 * The rows are the ones on the `Admin · ticket view` artboard, so a screenshot
 * of the fixture and the drawing are the same picture.
 */

const [SUPPORT, BILLING] = MOCK_DEPARTMENTS;
const SUPPORT_ID = SUPPORT?.id ?? '';
const BILLING_ID = BILLING?.id ?? '';

const YARA_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000c';

export const MOCK_TICKET_REFUND = '0192c3f0-1a2b-7c3d-8e4f-000000001042';
export const MOCK_TICKET_SIGN_IN = '0192c3f0-1a2b-7c3d-8e4f-000000001041';
export const MOCK_TICKET_ARABIC = '0192c3f0-1a2b-7c3d-8e4f-000000001039';
export const MOCK_TICKET_VAT = '0192c3f0-1a2b-7c3d-8e4f-000000001035';
export const MOCK_TICKET_CLOSED = '0192c3f0-1a2b-7c3d-8e4f-000000001030';
export const MOCK_TICKET_TRANSCRIPT = '0192c3f0-1a2b-7c3d-8e4f-000000001028';

export const MOCK_STATUS_OPEN = '0192c3f0-1a2b-7c3d-8e4f-000000000051';
export const MOCK_STATUS_AWAITING = '0192c3f0-1a2b-7c3d-8e4f-000000000052';
export const MOCK_STATUS_ESCALATED = '0192c3f0-1a2b-7c3d-8e4f-000000000053';
export const MOCK_STATUS_CLOSED = '0192c3f0-1a2b-7c3d-8e4f-000000000054';
export const MOCK_STATUS_SPAM = '0192c3f0-1a2b-7c3d-8e4f-000000000055';
export const MOCK_STATUS_MERGED = '0192c3f0-1a2b-7c3d-8e4f-000000000056';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The six a brand is seeded with (`seedBrandStatuses`, DOMAIN-RULES §2.1). */
const seedStatuses = (): TicketStatus[] => [
  status(MOCK_STATUS_OPEN, 'Open', 'مفتوحة', 'open', 'info', { isDefault: true, sortOrder: 1 }),
  status(MOCK_STATUS_AWAITING, 'Awaiting customer', 'بانتظار العميل', 'on_hold', 'warning', {
    pausesSla: true,
    awaitingCustomer: true,
    sortOrder: 2,
  }),
  status(MOCK_STATUS_ESCALATED, 'Escalated', 'مُصعَّدة', 'escalated', 'escalated', {
    sortOrder: 3,
  }),
  status(MOCK_STATUS_CLOSED, 'Closed', 'مغلقة', 'closed', 'success', { sortOrder: 4 }),
  status(MOCK_STATUS_SPAM, 'Spam', 'مزعجة', 'closed', 'danger', {
    excludedFromReports: true,
    sortOrder: 5,
  }),
  status(MOCK_STATUS_MERGED, 'Merged', 'مدمجة', 'closed', 'info', { sortOrder: 6 }),
];

function status(
  id: string,
  name: string,
  nameAr: string,
  systemState: TicketStatus['systemState'],
  color: TicketStatus['color'],
  overrides: Partial<TicketStatus> = {},
): TicketStatus {
  return {
    id,
    name,
    nameAr,
    systemState,
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    isSystem: true,
    // M1-11 reads it on Spam; the seed sets it there and nowhere else.
    excludedFromReports: false,
    sortOrder: 0,
    color,
    ...overrides,
  };
}

/** What the api keeps on a merged ticket so it can be undone (M1-09). */
interface MergeRecord {
  readonly mergedAt: string;
  readonly mergedById: string;
  readonly previousStatus: TicketStatus;
  readonly systemMessageId: string;
}

interface Seed {
  readonly tickets: Ticket[];
  readonly messages: TicketMessage[];
  readonly activity: TicketActivityEntry[];
}

const seed = (statuses: readonly TicketStatus[], now: number): Seed => {
  const at = (offset: number): string => new Date(now + offset).toISOString();
  const byId = (id: string): TicketStatus => {
    const found = statuses.find((candidate) => candidate.id === id);
    /* c8 ignore next 3 -- the ids above are the ids seeded. */
    if (found === undefined) {
      throw new Error(`no seeded status ${id}`);
    }

    return found;
  };

  const ticket = (overrides: Partial<Ticket> & Pick<Ticket, 'id' | 'number' | 'subject'>): Ticket =>
    ({
      prefix: 'HD',
      status: byId(MOCK_STATUS_OPEN),
      priority: 'medium' as TicketPriority,
      channel: 'email',
      departmentId: SUPPORT_ID,
      teamId: null,
      assigneeId: null,
      contactId: null,
      parentId: null,
      mergedIntoId: null,
      splitFromId: null,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      slaBreached: false,
      closedAt: null,
      custom: {},
      createdAt: at(-2 * DAY),
      updatedAt: at(-2 * DAY),
      ...overrides,
    }) as Ticket;

  const tickets: Ticket[] = [
    ticket({
      id: MOCK_TICKET_REFUND,
      number: 1042,
      subject: 'Refund for order 42 has not arrived',
      priority: 'urgent',
      contactId: MOCK_CONTACT_MONA,
      assigneeId: MOCK_SELF_ID,
      // Breached two hours ago, which is the SlaTimer state of the artboard.
      firstResponseDueAt: at(-2 * HOUR),
      resolutionDueAt: at(6 * HOUR),
      slaBreached: true,
      custom: { orderId: 'ORD-4812', plan: 'Business' },
      createdAt: at(-26 * HOUR),
      updatedAt: at(-12 * MINUTE),
    }),
    ticket({
      id: MOCK_TICKET_SIGN_IN,
      number: 1041,
      subject: 'Cannot sign in to the portal',
      priority: 'high',
      channel: 'chat',
      contactId: MOCK_CONTACT_GMAIL,
      firstResponseDueAt: at(3 * HOUR),
      resolutionDueAt: at(20 * HOUR),
      createdAt: at(-5 * HOUR),
      updatedAt: at(-40 * MINUTE),
    }),
    ticket({
      id: MOCK_TICKET_ARABIC,
      number: 1039,
      subject: 'طلب تغيير عنوان الشحن',
      status: byId(MOCK_STATUS_AWAITING),
      channel: 'telegram',
      contactId: MOCK_CONTACT_ARABIC,
      assigneeId: MOCK_SELF_ID,
      resolutionDueAt: at(30 * HOUR),
      createdAt: at(-3 * DAY),
      updatedAt: at(-4 * HOUR),
    }),
    ticket({
      id: MOCK_TICKET_VAT,
      number: 1035,
      subject: 'Invoice 2291 shows the wrong VAT',
      status: byId(MOCK_STATUS_ESCALATED),
      priority: 'high',
      departmentId: BILLING_ID,
      contactId: MOCK_CONTACT_ACCOUNT,
      assigneeId: YARA_ID,
      resolutionDueAt: at(-45 * MINUTE),
      createdAt: at(-4 * DAY),
      updatedAt: at(-9 * HOUR),
    }),
    ticket({
      id: MOCK_TICKET_CLOSED,
      number: 1030,
      subject: 'Duplicate charge on the September invoice',
      status: byId(MOCK_STATUS_CLOSED),
      priority: 'low',
      departmentId: BILLING_ID,
      contactId: MOCK_CONTACT_MONA,
      assigneeId: MOCK_SELF_ID,
      closedAt: at(-6 * DAY),
      createdAt: at(-9 * DAY),
      updatedAt: at(-6 * DAY),
    }),
    ticket({
      id: MOCK_TICKET_TRANSCRIPT,
      number: 1028,
      subject: 'Chat transcript request',
      channel: 'form',
      contactId: MOCK_CONTACT_VISITOR,
      // Overdue on resolution, which is what puts it in the Overdue view.
      resolutionDueAt: at(-3 * HOUR),
      createdAt: at(-11 * DAY),
      updatedAt: at(-2 * DAY),
    }),
  ];

  const message = (
    overrides: Partial<TicketMessage> & Pick<TicketMessage, 'id' | 'ticketId' | 'seq' | 'bodyText'>,
  ): TicketMessage => ({
    clientId: null,
    kind: 'public',
    authorType: 'contact',
    authorId: null,
    bodyHtml: `<p>${overrides.bodyText}</p>`,
    attachments: [],
    channel: 'email',
    createdAt: at(-1 * HOUR),
    ...overrides,
  });

  const messages: TicketMessage[] = [
    message({
      id: msgId(1),
      ticketId: MOCK_TICKET_REFUND,
      seq: 1,
      authorId: MOCK_CONTACT_MONA,
      bodyText:
        'I returned order 42 three weeks ago and the refund has still not reached my account. The return was confirmed by email on the 2nd.',
      attachments: [
        {
          id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
          ticketId: MOCK_TICKET_REFUND,
          messageId: msgId(1),
          uploaderType: 'contact',
          originalName: 'return-confirmation.pdf',
          mime: 'application/pdf',
          kind: 'file',
          size: 83_968,
          status: 'ready',
          rejectReason: null,
          scanStatus: 'clean',
          variants: {},
          createdAt: at(-26 * HOUR),
          processedAt: at(-26 * HOUR),
        },
      ],
      createdAt: at(-26 * HOUR),
    }),
    message({
      id: msgId(2),
      ticketId: MOCK_TICKET_REFUND,
      seq: 2,
      kind: 'ai',
      authorType: 'ai',
      bodyText:
        'Refunds are returned to the original payment method and usually clear within five working days of the return being received.',
      createdAt: at(-25 * HOUR),
    }),
    message({
      id: msgId(3),
      ticketId: MOCK_TICKET_REFUND,
      seq: 3,
      kind: 'note',
      authorType: 'staff',
      authorId: MOCK_SELF_ID,
      bodyText:
        '@Omar the warehouse marked this one received but finance has no record of it. Can you check the batch from the 2nd?',
      channel: 'manual',
      createdAt: at(-20 * HOUR),
    }),
    message({
      id: msgId(4),
      ticketId: MOCK_TICKET_REFUND,
      seq: 4,
      authorType: 'staff',
      authorId: MOCK_SELF_ID,
      bodyText:
        'Thank you for the reminder — I can see the return was received. I have asked finance to release the refund today and will confirm as soon as it is out.',
      createdAt: at(-12 * MINUTE),
    }),

    message({
      id: msgId(5),
      ticketId: MOCK_TICKET_SIGN_IN,
      seq: 1,
      authorId: MOCK_CONTACT_GMAIL,
      channel: 'chat',
      bodyText:
        'The portal keeps telling me my password is wrong, but the reset email never comes.',
      createdAt: at(-5 * HOUR),
    }),
    message({
      id: msgId(6),
      ticketId: MOCK_TICKET_ARABIC,
      seq: 1,
      authorId: MOCK_CONTACT_ARABIC,
      channel: 'telegram',
      bodyText: 'أرجو تغيير عنوان الشحن إلى المكتب قبل الإرسال.',
      createdAt: at(-3 * DAY),
    }),
    message({
      id: msgId(7),
      ticketId: MOCK_TICKET_VAT,
      seq: 1,
      authorId: MOCK_CONTACT_ACCOUNT,
      bodyText: 'Invoice 2291 charges 19% VAT, but our account is registered as exempt.',
      createdAt: at(-4 * DAY),
    }),
    message({
      id: msgId(8),
      ticketId: MOCK_TICKET_CLOSED,
      seq: 1,
      authorId: MOCK_CONTACT_MONA,
      bodyText: 'The September invoice was charged twice.',
      createdAt: at(-9 * DAY),
    }),
    message({
      id: msgId(9),
      ticketId: MOCK_TICKET_TRANSCRIPT,
      seq: 1,
      authorType: 'contact',
      channel: 'form',
      bodyText: 'Could you send me the transcript of the chat I had this morning?',
      createdAt: at(-11 * DAY),
    }),
  ];

  const activity: TicketActivityEntry[] = [
    {
      id: actId(1),
      ticketId: MOCK_TICKET_REFUND,
      actorType: 'system',
      actorId: 'system',
      action: 'ticket.created',
      from: null,
      to: null,
      via: 'system',
      createdAt: at(-26 * HOUR),
    },
    {
      id: actId(2),
      ticketId: MOCK_TICKET_REFUND,
      actorType: 'staff',
      actorId: MOCK_SELF_ID,
      action: 'ticket.updated',
      from: { priority: 'medium' },
      to: { priority: 'urgent' },
      via: 'rule',
      createdAt: at(-22 * HOUR),
    },
    {
      id: actId(3),
      ticketId: MOCK_TICKET_REFUND,
      actorType: 'staff',
      actorId: MOCK_SELF_ID,
      action: 'ticket.note_added',
      from: null,
      to: null,
      via: 'ui',
      createdAt: at(-20 * HOUR),
    },
    {
      id: actId(4),
      ticketId: MOCK_TICKET_VAT,
      actorType: 'staff',
      actorId: YARA_ID,
      action: 'ticket.status.changed',
      from: { status: 'Open' },
      to: { status: 'Escalated' },
      via: 'ui',
      createdAt: at(-9 * HOUR),
    },
  ];

  return { tickets, messages, activity };
};

const msgId = (n: number): string =>
  `0192c3f0-1a2b-7c3d-8e4f-0000000${String(700 + n).padStart(5, '0')}`;
const actId = (n: number): string =>
  `0192c3f0-1a2b-7c3d-8e4f-0000000${String(800 + n).padStart(5, '0')}`;

/** The cursor is opaque to a caller and an index to the fixture. */
const encodeCursor = (index: number): string => `c:${index}`;
const decodeCursor = (cursor: string | undefined): number => {
  const parsed = Number(cursor?.slice(2));

  return cursor?.startsWith('c:') === true && Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export class MockTicketsApi implements TicketsApi {
  readonly #statuses = seedStatuses();
  #tickets: Ticket[];
  #messages: TicketMessage[];
  #activity: TicketActivityEntry[];
  #sequence = 0;
  readonly #uploads: MockAttachmentUploader | undefined;
  /** Keyed by the secondary's id; present while it is merged. */
  readonly #merges = new Map<string, MergeRecord>();

  /**
   * The uploader fixture, when there is one, so that a file attached in the
   * composer is the file the thread then draws — the same arrangement
   * `MockAuthApi` and `MockStaffApi` have, and for the same reason.
   */
  constructor(uploads?: MockAttachmentUploader, now: number = Date.now()) {
    this.#uploads = uploads;
    const seeded = seed(this.#statuses, now);
    this.#tickets = seeded.tickets;
    this.#messages = seeded.messages;
    this.#activity = seeded.activity;
  }

  async statuses(_brandId: string): Promise<TicketStatusList> {
    return Promise.resolve({ statuses: [...this.#statuses] });
  }

  async list(_brandId: string, query: TicketQuery = {}): Promise<TicketList> {
    const term = query.q?.trim().toLowerCase() ?? '';
    const matches = this.#tickets
      .filter((ticket) => matchesQuery(ticket, query, term))
      .sort(comparator(query));

    const limit = query.limit ?? TICKET_PAGE_SIZE_DEFAULT;
    const from = decodeCursor(query.cursor);
    const page = matches.slice(from, from + limit);
    const nextIndex = from + page.length;

    return Promise.resolve({
      tickets: page,
      nextCursor: nextIndex < matches.length ? encodeCursor(nextIndex) : null,
    });
  }

  async ticket(_brandId: string, ticketId: string): Promise<TicketDetail> {
    const ticket = this.#require(ticketId);

    return Promise.resolve({
      ticket,
      messages: this.#page(ticketId, 0),
      activity: this.#activityOf(ticketId),
      ...this.#mergeView(ticket),
    });
  }

  async messages(_brandId: string, ticketId: string, after = 0): Promise<TicketMessagePage> {
    this.#require(ticketId);

    return Promise.resolve(this.#page(ticketId, after));
  }

  async activity(_brandId: string, ticketId: string): Promise<TicketActivityList> {
    this.#require(ticketId);

    return Promise.resolve({ activity: this.#activityOf(ticketId) });
  }

  async create(_brandId: string, request: TicketCreateRequest): Promise<TicketDetail> {
    // The api fills these from a template (M1-06); the workspace's dialog always
    // sends all three, so the fixture does not model templates.
    const { subject, bodyHtml, departmentId } = request;
    if (subject === undefined || bodyHtml === undefined || departmentId === undefined) {
      throw new Error('The fixture needs a subject, a body and a department.');
    }
    const now = new Date().toISOString();
    const number = Math.max(...this.#tickets.map((ticket) => ticket.number)) + 1;
    const ticket: Ticket = {
      id: this.#nextId('1'),
      number,
      prefix: 'HD',
      subject,
      status: this.#defaultStatus(),
      priority: request.priority ?? 'medium',
      channel: request.channel ?? 'manual',
      departmentId,
      teamId: null,
      assigneeId: request.assigneeId ?? null,
      contactId: request.contactId ?? null,
      parentId: null,
      mergedIntoId: null,
      splitFromId: null,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      slaBreached: false,
      closedAt: null,
      custom: {},
      createdAt: now,
      updatedAt: now,
    };

    this.#tickets = [ticket, ...this.#tickets];
    this.#messages = [
      ...this.#messages,
      {
        id: this.#nextId('7'),
        ticketId: ticket.id,
        seq: 1,
        clientId: request.clientId ?? null,
        kind: 'public',
        authorType: 'staff',
        authorId: MOCK_SELF_ID,
        bodyHtml,
        bodyText: textOf(bodyHtml),
        attachments: [],
        channel: ticket.channel,
        createdAt: now,
      },
    ];
    this.#activity = [
      ...this.#activity,
      {
        id: this.#nextId('8'),
        ticketId: ticket.id,
        actorType: 'staff',
        actorId: MOCK_SELF_ID,
        action: 'ticket.created',
        from: null,
        to: null,
        via: 'ui',
        createdAt: now,
      },
    ];

    return this.ticket(_brandId, ticket.id);
  }

  async update(_brandId: string, ticketId: string, request: TicketUpdateRequest): Promise<Ticket> {
    const ticket = this.#require(ticketId);
    // A merged ticket's state belongs to its primary (DOMAIN-RULES §2.4), and
    // so does its department; the api refuses both with the same reason.
    if (
      ticket.mergedIntoId !== null &&
      (request.statusId !== undefined || request.departmentId !== undefined)
    ) {
      throw new TicketLifecycleError('ticket-merged');
    }
    const status =
      request.statusId === undefined
        ? ticket.status
        : (this.#statuses.find((candidate) => candidate.id === request.statusId) ?? ticket.status);

    const updated: Ticket = {
      ...ticket,
      ...(request.subject === undefined ? {} : { subject: request.subject }),
      ...(request.priority === undefined ? {} : { priority: request.priority }),
      ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
      ...(request.assigneeId === undefined ? {} : { assigneeId: request.assigneeId }),
      status,
      closedAt: status.systemState === 'closed' ? (ticket.closedAt ?? isoNow()) : null,
      updatedAt: isoNow(),
    };

    this.#tickets = this.#tickets.map((row) => (row.id === ticketId ? updated : row));
    this.#activity = [
      ...this.#activity,
      {
        id: this.#nextId('8'),
        ticketId,
        actorType: 'staff',
        actorId: MOCK_SELF_ID,
        action: request.statusId === undefined ? 'ticket.updated' : 'ticket.status.changed',
        from: request.statusId === undefined ? null : { status: ticket.status.name },
        to: request.statusId === undefined ? null : { status: status.name },
        via: 'ui',
        createdAt: isoNow(),
      },
    ];

    return Promise.resolve(updated);
  }

  async reply(
    _brandId: string,
    ticketId: string,
    request: MessageCreateRequest,
  ): Promise<TicketMessage> {
    const ticket = this.#require(ticketId);

    // DOMAIN-RULES §7: `(conversation_id, client_id)` is unique, so a retry
    // gets the message the first attempt wrote, with the same id and the same
    // `seq`. A composer that retried would otherwise post twice.
    const existing =
      request.clientId === undefined
        ? undefined
        : this.#messages.find(
            (message) => message.ticketId === ticketId && message.clientId === request.clientId,
          );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    const message: TicketMessage = {
      id: this.#nextId('7'),
      ticketId,
      seq: this.#nextSeq(ticketId),
      clientId: request.clientId ?? null,
      kind: request.kind,
      authorType: 'staff',
      authorId: MOCK_SELF_ID,
      bodyHtml: request.bodyHtml,
      bodyText: textOf(request.bodyHtml),
      attachments: this.#link(ticketId, request.attachmentIds ?? []),
      channel: request.kind === 'note' ? 'manual' : ticket.channel,
      createdAt: isoNow(),
    };

    this.#messages = [...this.#messages, message];
    this.#activity = [
      ...this.#activity,
      {
        id: this.#nextId('8'),
        ticketId,
        actorType: 'staff',
        actorId: MOCK_SELF_ID,
        action: request.kind === 'note' ? 'ticket.note_added' : 'ticket.replied',
        from: null,
        to: null,
        via: 'ui',
        createdAt: message.createdAt,
      },
    ];
    // A reply bumps the ticket, so it rises to the front of its queue even
    // though none of the ticket's own columns moved.
    this.#tickets = this.#tickets.map((row) =>
      row.id === ticketId ? { ...row, updatedAt: message.createdAt } : row,
    );

    return Promise.resolve(message);
  }

  // ------------------------------------------------------- M1-09 merge, split

  /** The rules of `apps/api/src/tickets/merge/merge-rules.ts`, on the fixture's rows. */
  async merge(
    _brandId: string,
    ticketId: string,
    { primaryTicketId }: TicketMergeRequest,
  ): Promise<TicketMergeResult> {
    const secondary = this.#require(ticketId);
    const primary = this.#require(primaryTicketId);

    if (secondary.id === primary.id) {
      throw new TicketLifecycleError('merge-into-self');
    }
    if (secondary.mergedIntoId !== null) {
      throw new TicketLifecycleError('ticket-merged');
    }
    if (primary.mergedIntoId !== null) {
      throw new TicketLifecycleError('merge-into-merged');
    }

    const now = isoNow();
    const announcement = this.#system(
      primary,
      `${reference(secondary)} was merged into this ticket`,
    );
    this.#merges.set(secondary.id, {
      mergedAt: now,
      mergedById: MOCK_SELF_ID,
      previousStatus: secondary.status,
      systemMessageId: announcement.id,
    });

    const merged = this.#put({
      ...secondary,
      status: this.#statusOf(MOCK_STATUS_MERGED),
      mergedIntoId: primary.id,
      departmentId: primary.departmentId,
      closedAt: secondary.closedAt ?? now,
      updatedAt: now,
    });
    const tags = [...(primary.tags ?? [])];
    for (const tag of secondary.tags ?? []) {
      if (!tags.some((held) => held.id === tag.id)) {
        tags.push(tag);
      }
    }
    const receiving = this.#put({ ...primary, tags, updatedAt: now });
    this.#log(secondary.id, 'ticket.merged', { ticketId: secondary.id }, { ticketId: primary.id });
    this.#log(primary.id, 'ticket.merged', { ticketId: secondary.id }, { ticketId: primary.id });

    return Promise.resolve({ primary: receiving, secondary: merged });
  }

  async unmerge(_brandId: string, ticketId: string): Promise<TicketMergeResult> {
    const secondary = this.#require(ticketId);
    const record = this.#merges.get(ticketId);
    if (secondary.mergedIntoId === null || record === undefined) {
      throw new TicketLifecycleError('ticket-not-merged');
    }
    if (Date.now() - Date.parse(record.mergedAt) >= UNMERGE_WINDOW_MS) {
      throw new TicketLifecycleError('merge-window-closed');
    }

    const primary = this.#require(secondary.mergedIntoId);
    this.#merges.delete(ticketId);
    this.#system(primary, `${reference(secondary)} was unmerged from this ticket`);

    const restored = this.#put({
      ...secondary,
      status: record.previousStatus,
      mergedIntoId: null,
      closedAt: record.previousStatus.systemState === 'closed' ? secondary.closedAt : null,
      updatedAt: isoNow(),
    });
    this.#log(ticketId, 'ticket.unmerged', { ticketId }, { ticketId: primary.id });
    this.#log(primary.id, 'ticket.unmerged', { ticketId }, { ticketId: primary.id });

    return Promise.resolve({ primary: this.#require(primary.id), secondary: restored });
  }

  async split(
    brandId: string,
    ticketId: string,
    request: TicketSplitRequest,
  ): Promise<TicketDetail> {
    const original = this.#require(ticketId);
    const chosen = this.#messages
      .filter((message) => message.ticketId === ticketId && request.messageIds.includes(message.id))
      .sort((left, right) => left.seq - right.seq);
    if (chosen.length !== new Set(request.messageIds).size) {
      throw new Error('no such message on this ticket');
    }

    const now = isoNow();
    const created = this.#put({
      ...original,
      id: this.#nextId('1'),
      number: Math.max(...this.#tickets.map((ticket) => ticket.number)) + 1,
      subject: request.subject,
      departmentId: request.departmentId,
      priority: request.priority ?? original.priority,
      status: this.#defaultStatus(),
      assigneeId: null,
      mergedIntoId: null,
      splitFromId: original.id,
      closedAt: null,
      tags: [],
      custom: {},
      createdAt: now,
      updatedAt: now,
    });

    this.#messages = [
      ...this.#messages,
      ...chosen.map((message, index) => ({
        ...message,
        id: this.#nextId('7'),
        ticketId: created.id,
        seq: index + 1,
        clientId: null,
        attachments: message.attachments
          .filter((attachment) => attachment.status === 'ready')
          .map((attachment) => ({ ...attachment, id: this.#nextId('9'), ticketId: created.id })),
      })),
    ];
    this.#system(created, `Split from ${reference(original)}`);
    this.#system(original, `Messages split to ${reference(created)}`);
    this.#log(original.id, 'ticket.split', { ticketId: original.id }, { ticketId: created.id });
    this.#log(created.id, 'ticket.split', { ticketId: original.id }, { ticketId: created.id });

    return this.ticket(brandId, created.id);
  }

  /** The merge half of a ticket read, as `apps/api/src/tickets/merge/merge-view.ts` builds it. */
  #mergeView(ticket: Ticket): Pick<TicketDetail, 'merged' | 'mergedInto' | 'related'> {
    const merged: MergedTicket[] = [];
    let frontier = [ticket.id];
    while (frontier.length > 0) {
      const level = this.#tickets.filter(
        (row) => row.mergedIntoId !== null && frontier.includes(row.mergedIntoId),
      );
      for (const row of level) {
        const record = this.#merges.get(row.id);
        /* c8 ignore next 3 -- every merged row was merged through `merge`. */
        if (record === undefined) {
          continue;
        }
        merged.push({
          ...linkOf(row),
          ...this.#facts(record),
          mergedIntoId: row.mergedIntoId ?? ticket.id,
          systemMessageId: row.mergedIntoId === ticket.id ? record.systemMessageId : null,
          messages: this.#page(row.id, 0).messages,
          hasMoreMessages: false,
        });
      }
      frontier = level.map((row) => row.id);
    }

    const record = this.#merges.get(ticket.id);
    const primary =
      ticket.mergedIntoId === null
        ? undefined
        : this.#tickets.find((row) => row.id === ticket.mergedIntoId);

    return {
      merged,
      mergedInto:
        primary === undefined || record === undefined
          ? null
          : { ...linkOf(primary), ...this.#facts(record) },
      related: this.#tickets
        .filter((row) => row.splitFromId === ticket.id || row.id === ticket.splitFromId)
        .map(linkOf),
    };
  }

  #facts(record: MergeRecord) {
    const until = Date.parse(record.mergedAt) + UNMERGE_WINDOW_MS;

    return {
      mergedAt: record.mergedAt,
      mergedById: record.mergedById,
      unmergeableUntil: until > Date.now() ? new Date(until).toISOString() : null,
    };
  }

  /** A system row in a thread, the way the api writes "Continued in" and its kin. */
  #system(ticket: Ticket, text: string): TicketMessage {
    const message: TicketMessage = {
      id: this.#nextId('7'),
      ticketId: ticket.id,
      seq: this.#nextSeq(ticket.id),
      clientId: null,
      kind: 'system',
      authorType: 'system',
      authorId: MOCK_SELF_ID,
      bodyHtml: `<p>${text}</p>`,
      bodyText: text,
      attachments: [],
      channel: ticket.channel,
      createdAt: isoNow(),
    };
    this.#messages = [...this.#messages, message];

    return message;
  }

  #log(
    ticketId: string,
    action: string,
    from: Record<string, unknown>,
    to: Record<string, unknown>,
  ): void {
    this.#activity = [
      ...this.#activity,
      {
        id: this.#nextId('8'),
        ticketId,
        actorType: 'staff',
        actorId: MOCK_SELF_ID,
        action,
        from,
        to,
        via: 'ui',
        createdAt: isoNow(),
      },
    ];
  }

  /** Writes a row over the one with its id, or adds it. */
  #put(ticket: Ticket): Ticket {
    this.#tickets = this.#tickets.some((row) => row.id === ticket.id)
      ? this.#tickets.map((row) => (row.id === ticket.id ? ticket : row))
      : [ticket, ...this.#tickets];

    return ticket;
  }

  #statusOf(statusId: string): TicketStatus {
    const found = this.#statuses.find((candidate) => candidate.id === statusId);
    /* c8 ignore next 3 -- the ids are the ones seeded. */
    if (found === undefined) {
      throw new Error(`no seeded status ${statusId}`);
    }

    return found;
  }

  // ------------------------------------------------------------------

  #page(ticketId: string, after: number): TicketMessagePage {
    const all = this.#messages
      .filter((message) => message.ticketId === ticketId && message.seq > after)
      .sort((left, right) => left.seq - right.seq);
    const page = all.slice(0, TICKET_PAGE_SIZE_DEFAULT);
    const last = page.at(-1);

    return {
      messages: page,
      nextAfter: page.length < all.length && last !== undefined ? last.seq : null,
    };
  }

  /**
   * The rows for the ids a send named. An id this fixture cannot resolve is
   * dropped rather than invented: the api refuses the whole send in that case,
   * and a fixture that made one up would hide the refusal from every test.
   */
  #link(ticketId: string, attachmentIds: readonly string[]): Attachment[] {
    return attachmentIds
      .map((id) => this.#uploads?.row(id))
      .filter((row): row is Attachment => row !== undefined)
      .map((row) => ({ ...row, ticketId }));
  }

  #activityOf(ticketId: string): TicketActivityEntry[] {
    return this.#activity
      .filter((entry) => entry.ticketId === ticketId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  #nextSeq(ticketId: string): number {
    return (
      this.#messages
        .filter((message) => message.ticketId === ticketId)
        .reduce((highest, message) => Math.max(highest, message.seq), 0) + 1
    );
  }

  #defaultStatus(): TicketStatus {
    const fallback = this.#statuses[0];
    /* c8 ignore next 3 -- the seed always has six. */
    if (fallback === undefined) {
      throw new Error('a brand always has statuses');
    }

    return this.#statuses.find((candidate) => candidate.isDefault) ?? fallback;
  }

  #require(ticketId: string): Ticket {
    const ticket = this.#tickets.find((candidate) => candidate.id === ticketId);
    // What the policies answer for a ticket in another department, and what
    // they answer for one that does not exist. One sentence, deliberately.
    if (ticket === undefined) {
      throw new Error(`no such ticket: ${ticketId}`);
    }

    return ticket;
  }

  #nextId(group: string): string {
    this.#sequence += 1;

    return `0192c3f0-1a2b-7c3d-8e4f-0000000${group}${String(this.#sequence).padStart(4, '0')}`;
  }
}

const isoNow = (): string => new Date().toISOString();

const reference = (ticket: Ticket): string => `${ticket.prefix}-${ticket.number}`;

const linkOf = (ticket: Ticket): TicketLink => ({
  id: ticket.id,
  number: ticket.number,
  prefix: ticket.prefix,
  subject: ticket.subject,
});

/**
 * The text of a body, the way `body_text` is the text of `body_html`.
 *
 * The parser, not a regular expression over the markup: stripping `<...>` with
 * a pattern is the mistake that leaves `<scr<script>ipt>` behind, and a fixture
 * that taught that habit would be read as the way to do it. The api extracts
 * its own text with the sanitiser that produced the html (ADR 0007); this is
 * the fixture standing in for that, and it is not a sanitiser either.
 */
const textOf = (html: string): string =>
  new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? '';

const PRIORITY_ORDER: Record<TicketPriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

const matchesQuery = (ticket: Ticket, query: TicketQuery, term: string): boolean => {
  const inList = <T>(values: readonly T[] | undefined, value: T): boolean =>
    values === undefined || values.length === 0 || values.includes(value);

  const assignee =
    query.assigneeId === undefined ||
    query.assigneeId.length === 0 ||
    query.assigneeId.some((wanted) =>
      wanted === 'unassigned' ? ticket.assigneeId === null : ticket.assigneeId === wanted,
    );

  return (
    inList(query.statusId, ticket.status.id) &&
    inList(query.systemState, ticket.status.systemState) &&
    inList(query.priority, ticket.priority) &&
    inList(query.departmentId, ticket.departmentId) &&
    inList(query.channel, ticket.channel) &&
    assignee &&
    (term === '' ||
      ticket.subject.toLowerCase().includes(term) ||
      `${ticket.prefix}-${ticket.number}`.toLowerCase().includes(term))
  );
};

const comparator =
  (query: TicketQuery) =>
  (left: Ticket, right: Ticket): number => {
    const descending = (query.direction ?? 'desc') === 'desc' ? -1 : 1;

    switch (query.sort ?? 'updatedAt') {
      case 'number':
        return (left.number - right.number) * descending;
      case 'priority':
        return (PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]) * descending;
      case 'createdAt':
        return left.createdAt.localeCompare(right.createdAt) * descending;
      default:
        return left.updatedAt.localeCompare(right.updatedAt) * descending;
    }
  };
