import type {
  Attachment,
  MetaDeliveryView,
  Ticket,
  TicketMessage,
  TicketStatus,
} from '@helpdock/schemas';
import {
  MOCK_CONTACT_DANIEL,
  MOCK_CONTACT_MESSENGER_USER,
  MOCK_CONTACT_SARA,
  MOCK_META_CONVERSATIONS,
  MOCK_TICKET_INSTAGRAM,
  MOCK_TICKET_MESSENGER,
  MOCK_TICKET_WHATSAPP,
  metaAttachmentId,
  metaDeliveryId,
  metaMessageId,
} from '../meta/mock-conversations.js';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../staff/mock-api.js';

/**
 * The three Meta threads of `Admin/Ticket-Meta` (M10-08), as the api would
 * return them: one WhatsApp ticket with its window open, one Messenger ticket in
 * the Human Agent days, one Instagram ticket whose window has closed. What the
 * columns of the artboard draw is here: a quoted message, a sticker, a story
 * reply, a reaction, an unsent message, something Helpdock cannot show, and
 * replies in every delivery state (`metaDeliverySeed` holds the deliveries).
 *
 * Every time is relative to when the fixture was built, as the rest of the
 * ticket fixture's are.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const [SUPPORT, , ONBOARDING] = MOCK_DEPARTMENTS;

/** How long before the fixture was built each thread's customer last wrote, so thread and strip agree. */
const lastWrote = (ticketId: string): number =>
  MOCK_META_CONVERSATIONS[ticketId]?.lastInboundAgo ?? 0;

const waAnchor = lastWrote(MOCK_TICKET_WHATSAPP);
const igAnchor = lastWrote(MOCK_TICKET_INSTAGRAM);
const msAnchor = lastWrote(MOCK_TICKET_MESSENGER);

/** How long before the fixture was built each reply that has a delivery was written. */
const REPLY_AGO = {
  waRead: 27 * HOUR - 10 * MINUTE,
  waDelivered: 26 * HOUR,
  waRefused: 100 * MINUTE,
  waSent: 40 * MINUTE,
  waSending: 10 * MINUTE,
  msRead: msAnchor - 5 * MINUTE,
  msFailed: msAnchor - 30 * MINUTE,
  igRead: igAnchor + 60 * MINUTE,
} as const;

interface Factories {
  /** `at(-HOUR)` is an hour before the fixture was built. */
  readonly at: (offset: number) => string;
  readonly ticket: (
    overrides: Partial<Ticket> & Pick<Ticket, 'id' | 'number' | 'subject'>,
  ) => Ticket;
  readonly message: (
    overrides: Partial<TicketMessage> & Pick<TicketMessage, 'id' | 'ticketId' | 'seq' | 'bodyText'>,
  ) => TicketMessage;
  readonly open: TicketStatus;
}

type MetaChannel = 'whatsapp' | 'messenger' | 'instagram';

export const metaSeed = ({
  at,
  ticket,
  message,
  open,
}: Factories): { tickets: Ticket[]; messages: TicketMessage[] } => {
  const file = (
    n: number,
    ticketId: string,
    messageId: string,
    fields: Pick<Attachment, 'originalName' | 'mime' | 'kind' | 'size'> & Partial<Attachment>,
    when: string,
  ): Attachment => ({
    id: metaAttachmentId(n),
    ticketId,
    messageId,
    uploaderType: 'contact',
    status: 'ready',
    rejectReason: null,
    scanStatus: 'clean',
    variants: {},
    createdAt: when,
    processedAt: when,
    ...fields,
  });

  /** A message from the customer. */
  const from = (
    ticketId: string,
    channel: MetaChannel,
    contactId: string,
    id: number,
    seq: number,
    ago: number,
    overrides: Partial<TicketMessage> & { bodyText: string },
  ) =>
    message({
      id: metaMessageId(id),
      ticketId,
      seq,
      authorId: contactId,
      channel,
      createdAt: at(-ago),
      ...overrides,
    });
  /** A public reply from the agent. */
  const reply = (
    ticketId: string,
    channel: MetaChannel,
    id: number,
    seq: number,
    ago: number,
    overrides: Partial<TicketMessage> & { bodyText: string },
  ) =>
    message({
      id: metaMessageId(id),
      ticketId,
      seq,
      authorType: 'staff',
      authorId: MOCK_SELF_ID,
      channel,
      createdAt: at(-ago),
      ...overrides,
    });
  /** A line nobody wrote: a reaction, a message the customer unsent, something Helpdock cannot show. */
  const line = (
    ticketId: string,
    channel: MetaChannel,
    id: number,
    seq: number,
    ago: number,
    bodyText: string,
  ) =>
    message({
      id: metaMessageId(id),
      ticketId,
      seq,
      kind: 'system',
      authorType: 'system',
      authorId: null,
      channel,
      bodyText,
      createdAt: at(-ago),
    });

  const tickets: Ticket[] = [
    ticket({
      id: MOCK_TICKET_WHATSAPP,
      number: 1040,
      subject: 'Order 9120 arrived with a cracked lid',
      channel: 'whatsapp',
      contactId: MOCK_CONTACT_DANIEL,
      assigneeId: MOCK_SELF_ID,
      departmentId: SUPPORT?.id ?? '',
      status: open,
      resolutionDueAt: at(20 * HOUR),
      createdAt: at(-27 * HOUR),
      updatedAt: at(-10 * MINUTE),
    }),
    ticket({
      id: MOCK_TICKET_MESSENGER,
      number: 1038,
      subject: 'Do you ship to Ireland?',
      channel: 'messenger',
      priority: 'low',
      contactId: MOCK_CONTACT_MESSENGER_USER,
      assigneeId: MOCK_SELF_ID,
      departmentId: SUPPORT?.id ?? '',
      status: open,
      createdAt: at(-30 * HOUR),
      updatedAt: at(-29 * HOUR),
    }),
    ticket({
      id: MOCK_TICKET_INSTAGRAM,
      number: 1036,
      subject: 'Is the green jar back in stock?',
      channel: 'instagram',
      contactId: MOCK_CONTACT_SARA,
      assigneeId: MOCK_SELF_ID,
      departmentId: ONBOARDING?.id ?? '',
      status: open,
      createdAt: at(-8 * DAY - HOUR),
      updatedAt: at(-8 * DAY),
    }),
  ];

  const daniel = (id: number, seq: number, ago: number, overrides: Partial<TicketMessage> & { bodyText: string }) =>
    from(MOCK_TICKET_WHATSAPP, 'whatsapp', MOCK_CONTACT_DANIEL, id, seq, ago, overrides);

  const messages: TicketMessage[] = [
    // WhatsApp: a photo, a quote, a sticker, a reply that was refused because
    // the window had closed, and the customer writing again.
    daniel(0x10, 1, 27 * HOUR, {
      bodyText: 'Hi, order 9120 arrived today and the lid of the blender jar is cracked.',
      attachments: [
        file(
          1,
          MOCK_TICKET_WHATSAPP,
          metaMessageId(0x10),
          {
            originalName: 'IMG-20261011-WA0004.jpg',
            mime: 'image/webp',
            kind: 'image',
            size: 212_992,
          },
          at(-27 * HOUR),
        ),
      ],
    }),
    reply(MOCK_TICKET_WHATSAPP, 'whatsapp', 0x11, 2, REPLY_AGO.waRead, {
      bodyText: 'Sorry about that, Daniel. Could you send a photo of the label on the box too?',
    }),
    daniel(0x12, 3, 26 * HOUR + 30 * MINUTE, {
      bodyText: 'Here it is.',
      bodyHtml:
        '<blockquote><p>Could you send a photo of the label on the box too?</p></blockquote><p>Here it is.</p>',
      attachments: [
        file(
          2,
          MOCK_TICKET_WHATSAPP,
          metaMessageId(0x12),
          {
            originalName: 'IMG-20261011-WA0007.jpg',
            mime: 'image/webp',
            kind: 'image',
            size: 168_960,
          },
          at(-26 * HOUR - 30 * MINUTE),
        ),
      ],
    }),
    daniel(0x13, 4, 26 * HOUR + 29 * MINUTE, {
      bodyText: '',
      bodyHtml: '',
      attachments: [
        file(
          3,
          MOCK_TICKET_WHATSAPP,
          metaMessageId(0x13),
          { originalName: 'sticker.webp', mime: 'image/webp', kind: 'image', size: 21_504 },
          at(-26 * HOUR - 29 * MINUTE),
        ),
      ],
    }),
    reply(MOCK_TICKET_WHATSAPP, 'whatsapp', 0x14, 5, REPLY_AGO.waDelivered, {
      bodyText:
        'Thanks, Daniel. A replacement jar ships tomorrow; I will send the tracking number here.',
    }),
    reply(MOCK_TICKET_WHATSAPP, 'whatsapp', 0x15, 6, REPLY_AGO.waRefused, {
      bodyText: 'Hi Daniel, the courier could not reach you. Can we rebook?',
    }),
    daniel(0x16, 7, waAnchor, {
      bodyText: 'Sorry, I was out. Tomorrow morning works.',
    }),
    reply(MOCK_TICKET_WHATSAPP, 'whatsapp', 0x17, 8, REPLY_AGO.waSent, {
      bodyText: 'Tracking: RM 4471 0928 GB.',
      attachments: [
        file(
          4,
          MOCK_TICKET_WHATSAPP,
          metaMessageId(0x17),
          {
            originalName: 'return-label-9120.pdf',
            mime: 'application/pdf',
            kind: 'file',
            size: 86_016,
            uploaderType: 'staff',
          },
          at(-REPLY_AGO.waSent),
        ),
      ],
    }),
    reply(MOCK_TICKET_WHATSAPP, 'whatsapp', 0x18, 9, REPLY_AGO.waSending, {
      bodyText: 'Here is the care guide for the new jar, with a photo of how to fit the lid.',
      attachments: [
        file(
          5,
          MOCK_TICKET_WHATSAPP,
          metaMessageId(0x18),
          {
            originalName: 'care-guide.pdf',
            mime: 'application/pdf',
            kind: 'file',
            size: 1_258_291,
            uploaderType: 'staff',
          },
          at(-REPLY_AGO.waSending),
        ),
        file(
          6,
          MOCK_TICKET_WHATSAPP,
          metaMessageId(0x18),
          {
            originalName: 'lid-fitting.jpg',
            mime: 'image/webp',
            kind: 'image',
            size: 412_672,
            uploaderType: 'staff',
          },
          at(-REPLY_AGO.waSending),
        ),
      ],
    }),

    // Messenger: no name without profile access, a reaction, and a reply
    // whose second message Meta refused five times.
    from(MOCK_TICKET_MESSENGER, 'messenger', MOCK_CONTACT_MESSENGER_USER, 0x20, 1, msAnchor, {
      bodyText: 'Do you ship to Ireland? And how long does it take?',
    }),
    reply(MOCK_TICKET_MESSENGER, 'messenger', 0x21, 2, REPLY_AGO.msRead, {
      bodyText: 'Yes, we ship to Ireland: 3 to 5 working days, and free over €60.',
    }),
    line(
      MOCK_TICKET_MESSENGER,
      'messenger',
      0x22,
      3,
      msAnchor - 15 * MINUTE,
      'The customer reacted 👍 to a message.',
    ),
    reply(MOCK_TICKET_MESSENGER, 'messenger', 0x23, 4, REPLY_AGO.msFailed, {
      bodyText: 'Here is our warranty card, in case you need it.',
      attachments: [
        file(
          7,
          MOCK_TICKET_MESSENGER,
          metaMessageId(0x23),
          {
            originalName: 'warranty-card.jpg',
            mime: 'image/webp',
            kind: 'image',
            size: 225_280,
            uploaderType: 'staff',
          },
          at(-REPLY_AGO.msFailed),
        ),
      ],
    }),

    // Instagram: a story reply, an unsent message, a file Instagram would not
    // take, and something Helpdock cannot show.
    from(MOCK_TICKET_INSTAGRAM, 'instagram', MOCK_CONTACT_SARA, 0x30, 1, igAnchor + 70 * MINUTE, {
      bodyText: 'Replied to your story\nIs the green one back in stock?',
      bodyHtml: '<p>Replied to your story</p><p>Is the green one back in stock?</p>',
      attachments: [
        file(
          8,
          MOCK_TICKET_INSTAGRAM,
          metaMessageId(0x30),
          { originalName: 'story.jpg', mime: 'image/webp', kind: 'image', size: 131_072 },
          at(-igAnchor - 70 * MINUTE),
        ),
      ],
    }),
    from(MOCK_TICKET_INSTAGRAM, 'instagram', MOCK_CONTACT_SARA, 0x31, 2, igAnchor + 65 * MINUTE, {
      bodyText: 'Also the lid in blue?',
    }),
    line(
      MOCK_TICKET_INSTAGRAM,
      'instagram',
      0x32,
      3,
      igAnchor + 64 * MINUTE,
      'The customer unsent this message.',
    ),
    reply(MOCK_TICKET_INSTAGRAM, 'instagram', 0x33, 4, REPLY_AGO.igRead, {
      bodyText:
        'Yes, it has been back since Monday. Here is the care guide; the warranty terms follow by email.',
      attachments: [
        file(
          9,
          MOCK_TICKET_INSTAGRAM,
          metaMessageId(0x33),
          {
            originalName: 'care-guide.pdf',
            mime: 'application/pdf',
            kind: 'file',
            size: 1_258_291,
            uploaderType: 'staff',
          },
          at(-REPLY_AGO.igRead),
        ),
        file(
          10,
          MOCK_TICKET_INSTAGRAM,
          metaMessageId(0x33),
          {
            originalName: 'warranty-terms.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            kind: 'file',
            size: 48_128,
            uploaderType: 'staff',
          },
          at(-REPLY_AGO.igRead),
        ),
      ],
    }),
    line(
      MOCK_TICKET_INSTAGRAM,
      'instagram',
      0x34,
      5,
      igAnchor,
      'The customer sent something that cannot be shown here.',
    ),
  ];

  return { tickets, messages };
};

/**
 * What each reply of the three threads has become on the platform, by the
 * panels of `Admin/Ticket-Meta`: Read, Delivered, Refused because the window
 * had closed, Sent as two messages, Sending part 2 of 3, a Messenger reply
 * whose second message Meta refused five times, and an Instagram reply that
 * left one file out. `at` is when the fixture was built.
 */
export const metaDeliverySeed = (at: number): Record<string, MetaDeliveryView[]> => {
  const when = (ago: number, afterMinutes = 0): string =>
    new Date(at - ago + afterMinutes * MINUTE).toISOString();
  const base = (n: number, ago: number) => ({
    id: metaDeliveryId(n),
    ticketMessageId: metaMessageId(n),
    partsSent: 1,
    partsTotal: 1,
    leftOut: [],
    attempts: 0,
    lastError: null,
    errorCode: null,
    tag: null,
    templateName: null,
    sentAt: when(ago),
    deliveredAt: null,
    readAt: null,
    failedAt: null,
  });

  const whatsapp: MetaDeliveryView[] = [
    {
      ...base(0x11, REPLY_AGO.waRead),
      status: 'read',
      deliveredAt: when(REPLY_AGO.waRead, 1),
      readAt: when(REPLY_AGO.waRead, 2),
    },
    {
      ...base(0x14, REPLY_AGO.waDelivered),
      status: 'delivered',
      deliveredAt: when(REPLY_AGO.waDelivered, 1),
    },
    {
      ...base(0x15, REPLY_AGO.waRefused),
      status: 'refused',
      partsSent: 0,
      sentAt: null,
      lastError:
        'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
      errorCode: '131047',
      failedAt: when(REPLY_AGO.waRefused, 1),
    },
    { ...base(0x17, REPLY_AGO.waSent), status: 'sent', partsSent: 2, partsTotal: 2 },
    { ...base(0x18, REPLY_AGO.waSending), status: 'queued', partsSent: 1, partsTotal: 3 },
  ];
  const messenger: MetaDeliveryView[] = [
    {
      ...base(0x21, REPLY_AGO.msRead),
      status: 'read',
      deliveredAt: when(REPLY_AGO.msRead, 1),
      readAt: when(REPLY_AGO.msRead, 2),
    },
    {
      ...base(0x23, REPLY_AGO.msFailed),
      status: 'failed',
      partsTotal: 2,
      attempts: 5,
      lastError: '(#1200) Temporary send message failure. Please try again later.',
      errorCode: '1200',
      failedAt: when(REPLY_AGO.msFailed, 8),
    },
  ];
  const instagram: MetaDeliveryView[] = [
    {
      ...base(0x33, REPLY_AGO.igRead),
      status: 'read',
      partsSent: 2,
      partsTotal: 2,
      leftOut: [
        {
          attachmentId: metaAttachmentId(10),
          name: 'warranty-terms.docx',
          reason: 'unsupported-type',
        },
      ],
      deliveredAt: when(REPLY_AGO.igRead, 1),
      readAt: when(REPLY_AGO.igRead, 2),
    },
  ];

  return {
    [MOCK_TICKET_WHATSAPP]: whatsapp,
    [MOCK_TICKET_MESSENGER]: messenger,
    [MOCK_TICKET_INSTAGRAM]: instagram,
  };
};
