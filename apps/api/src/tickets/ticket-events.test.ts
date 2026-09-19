import type { JobLogger } from '@helpdock/jobs';
import { departmentRoom, REALTIME_EVENTS, ticketRoom } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { RealtimeBroadcast, RealtimeBroadcastInput } from '../realtime/broadcast.js';
import { silentLogger } from '../testing/silent-logger.js';
import { createTicketEventHandler, roomsFor, TICKET_EVENTS } from './ticket-events.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const DEPARTMENT = '01937f5e-7e53-7000-8000-000000000011';
const OTHER_DEPARTMENT = '01937f5e-7e53-7000-8000-000000000012';
const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';
const MESSAGE = '01937f5e-7e53-7000-8000-0000000000b1';

const recorder = () => {
  const sent: RealtimeBroadcastInput[] = [];

  return {
    sent,
    broadcast: {
      emit: (input) => {
        sent.push(input);
        return Promise.resolve();
      },
    } satisfies RealtimeBroadcast,
  };
};

const context = (event: string, payload: Record<string, unknown>) => ({
  outboxId: '01937f5e-7e53-7000-8000-0000000000c1',
  brandId: BRAND,
  event,
  payload,
  // The handler never queries; the transaction is there for the ones that do.
  tx: undefined as never,
  log: silentLogger() as unknown as JobLogger,
});

describe('roomsFor', () => {
  it('names the ticket room and the department room', () => {
    // The ticket room is whoever has it open; the department room is whoever
    // has a queue open, because a new ticket has to appear in a list nobody was
    // looking at.
    expect(roomsFor({ ticketId: TICKET, departmentId: DEPARTMENT })).toEqual([
      ticketRoom(TICKET),
      departmentRoom(DEPARTMENT),
    ]);
  });
});

describe('the ticket outbox handler', () => {
  it('turns ticket.created into a ticket:changed frame with no seq', async () => {
    const { sent, broadcast } = recorder();

    await createTicketEventHandler(broadcast)(
      context(TICKET_EVENTS.created, { ticketId: TICKET, departmentId: DEPARTMENT }),
    );

    expect(sent).toEqual([
      {
        rooms: [ticketRoom(TICKET), departmentRoom(DEPARTMENT)],
        event: REALTIME_EVENTS.ticketChanged,
        data: {
          brandId: BRAND,
          ticketId: TICKET,
          departmentId: DEPARTMENT,
          event: 'ticket.created',
        },
        // A ticket change has no per-ticket cursor to catch up from, and §7
        // reserves `seq` for what a client replays.
        seq: null,
      },
    ]);
  });

  it('turns ticket.updated into the same frame under its own name', async () => {
    const { sent, broadcast } = recorder();

    await createTicketEventHandler(broadcast)(
      context(TICKET_EVENTS.updated, { ticketId: TICKET, departmentId: DEPARTMENT }),
    );

    expect(sent[0]?.data).toMatchObject({ event: 'ticket.updated' });
    expect(sent[0]?.evict).toBeUndefined();
  });

  it('turns the ticket room out when the ticket changed department', async () => {
    // Everyone in it joined under the old department's scope, and who may read
    // the ticket has just changed.
    const { sent, broadcast } = recorder();

    await createTicketEventHandler(broadcast)(
      context(TICKET_EVENTS.updated, {
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        previousDepartmentId: OTHER_DEPARTMENT,
      }),
    );

    expect(sent[0]?.evict).toEqual([ticketRoom(TICKET)]);
  });

  it('carries the message seq on a reply, which is what a client catches up from', async () => {
    const { sent, broadcast } = recorder();

    await createTicketEventHandler(broadcast)(
      context(TICKET_EVENTS.replied, {
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        messageId: MESSAGE,
        seq: 4,
        kind: 'public',
      }),
    );

    expect(sent[0]).toMatchObject({
      event: REALTIME_EVENTS.ticketMessage,
      seq: 4,
      data: { messageId: MESSAGE, seq: 4, kind: 'public', event: 'ticket.replied' },
    });
  });

  it('strips a body somebody put in the outbox row, so a note cannot leak', async () => {
    // The payload is read out of the database and crosses a process boundary.
    // Parsing it through the event's own schema is what drops a field the
    // frame does not declare — this asserts that stripping, not the absence of
    // a field nobody sent.
    const { sent, broadcast } = recorder();

    await createTicketEventHandler(broadcast)(
      context(TICKET_EVENTS.noteAdded, {
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        messageId: MESSAGE,
        seq: 5,
        kind: 'note',
        bodyHtml: '<p>chasing finance about the refund</p>',
        bodyText: 'chasing finance about the refund',
      }),
    );

    expect(JSON.stringify(sent[0]?.data)).not.toContain('finance');
    expect(sent[0]?.data).toMatchObject({ kind: 'note', event: 'ticket.note_added' });
  });

  it('refuses a payload that does not match its schema', async () => {
    // The payload arrives from the database and crosses a process boundary; a
    // consumer that trusted it would emit whatever was written into `outbox`.
    const { broadcast } = recorder();

    await expect(
      createTicketEventHandler(broadcast)(
        context(TICKET_EVENTS.replied, { ticketId: 'not-a-uuid', departmentId: DEPARTMENT }),
      ),
    ).rejects.toThrow();
  });
});
