import type {
  TicketMessage as TicketMessageRow,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { widgetConversationSchema, widgetMessageSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { attachmentRow } from '../testing/media.js';
import { toWidgetConversation, toWidgetMessage } from './widget-view.js';

const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const AGENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000a9';
const CLIENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000cc';
const AT = new Date('2026-09-27T10:00:00.000Z');

const message = (overrides: Partial<TicketMessageRow> = {}): TicketMessageRow =>
  ({
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000010',
    brandId: '0192c3f0-1a2b-7c3d-8e4f-0000000000b1',
    ticketId: TICKET,
    departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
    seq: 3,
    clientId: CLIENT,
    kind: 'public',
    authorType: 'staff',
    authorId: AGENT,
    bodyHtml: '<p>On its way</p>',
    bodyText: 'On its way',
    channel: 'chat',
    externalMessageId: null,
    copiedFromMessageId: null,
    aiMeta: null,
    email: null,
    createdAt: AT,
    ...overrides,
  }) as TicketMessageRow;

const staffNames = new Map([[AGENT, 'Lina Haddad']]);

describe('toWidgetMessage', () => {
  it("signs an agent's reply with a first name when the brand shows agents", () => {
    const view = toWidgetMessage(message(), [], { staffNames, showAgentIdentity: true });

    expect(widgetMessageSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      author: 'agent',
      agent: { name: 'Lina', avatarUrl: null },
      clientId: null,
      html: '<p>On its way</p>',
    });
  });

  it('signs nothing when the brand hides agents', () => {
    expect(
      toWidgetMessage(message(), [], { staffNames, showAgentIdentity: false }).agent,
    ).toBeNull();
  });

  it("gives a visitor's own message back its clientId and no HTML", () => {
    const view = toWidgetMessage(message({ authorType: 'contact', authorId: null }), [], {
      staffNames,
      showAgentIdentity: true,
    });

    expect(view).toMatchObject({ author: 'visitor', clientId: CLIENT, html: null, agent: null });
  });

  it('carries attachments without their object keys', () => {
    const file = attachmentRow({ originalName: 'receipt.png', status: 'ready', size: 42 });
    const view = toWidgetMessage(message(), [file], { staffNames, showAgentIdentity: true });

    expect(view.attachments).toEqual([
      {
        id: file.id,
        kind: 'image',
        name: 'receipt.png',
        mime: 'image/png',
        size: 42,
        status: 'ready',
      },
    ]);
    expect(JSON.stringify(view)).not.toContain(file.s3Key);
  });
});

describe('toWidgetConversation', () => {
  const ticket = {
    id: TICKET,
    prefix: 'HD',
    number: 1042,
    subject: 'Refund',
    channel: 'chat',
    mergedIntoId: null,
    createdAt: AT,
    updatedAt: AT,
  } as TicketRow;
  const open = { systemState: 'open' } as TicketStatusRow;
  const hours = { open: true, nextOpenAt: null, timezone: 'Asia/Riyadh' };

  it('names the conversation by its reference and says whether it is open', () => {
    const view = toWidgetConversation({ ticket, status: open }, 7, null, hours);

    expect(widgetConversationSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({ reference: 'HD-1042', state: 'open', lastSeq: 7 });
  });

  it('carries the hours of the team answering it, as it was given them (M7-06)', () => {
    const closed = { open: false, nextOpenAt: '2026-09-27T06:00:00.000Z', timezone: 'Asia/Riyadh' };

    expect(toWidgetConversation({ ticket, status: open }, 0, null, closed).hours).toEqual(closed);
  });

  it('calls a closed or merged ticket closed', () => {
    const closed = { systemState: 'closed' } as TicketStatusRow;
    const continuation = '0192c3f0-1a2b-7c3d-8e4f-000000000002';

    expect(toWidgetConversation({ ticket, status: closed }, 0, continuation, hours)).toMatchObject({
      state: 'closed',
      continuedById: continuation,
    });
    expect(
      toWidgetConversation(
        { ticket: { ...ticket, mergedIntoId: continuation }, status: open },
        0,
        null,
        hours,
      ).state,
    ).toBe('closed');
  });
});
