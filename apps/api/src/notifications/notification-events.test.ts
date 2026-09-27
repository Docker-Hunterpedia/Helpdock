import type { DbTransaction } from '@helpdock/db';
import { type NotifyEmailPayload, type NotifyPushPayload, silentLogger } from '@helpdock/jobs';
import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  type NotificationPreferences,
  REALTIME_EVENTS,
  userRoom,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { RealtimeBroadcastInput } from '../realtime/broadcast.js';
import { TICKET_ASSIGNED_EVENT, TICKET_EVENTS } from '../tickets/ticket-events.js';
import {
  CONSUMED_EVENTS,
  createFanOutHandler,
  createNotificationCreatedHandler,
  createPushTestHandler,
  emailJobId,
  NOTIFICATION_EVENTS,
  planFor,
  pushJobId,
  SLA_EVENTS,
  TICKET_ESCALATED_EVENT,
} from './notification-events.js';
import type {
  DeliveryFacts,
  MessageFacts,
  NewNotificationRow,
  NotificationsRepository,
  SubscriptionRow,
  TicketFacts,
} from './notifications.repository.js';
import type { StaffFacts } from './recipients.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
const SUPPORT = '0199f4b2-3333-7000-8000-0000000000d1';
const BILLING = '0199f4b2-3333-7000-8000-0000000000d2';
const TEAM = '0199f4b2-4444-7000-8000-0000000000e1';
const MESSAGE = '0199f4b2-5555-7000-8000-0000000000f1';
const OUTBOX = '0199f4b2-6666-7000-8000-000000000001';
const NOTIFICATION = '0199f4b2-7777-7000-8000-000000000001';
const SUBSCRIPTION = '0199f4b2-8888-7000-8000-000000000001';

const LINA = '0199f4b2-1111-7000-8000-000000000001';
const OMAR = '0199f4b2-1111-7000-8000-000000000002';
const SUE = '0199f4b2-1111-7000-8000-000000000003';
const BO = '0199f4b2-1111-7000-8000-000000000004';

const members: StaffFacts[] = [
  {
    userId: LINA,
    name: 'Lina Haddad',
    email: 'lina@x.test',
    departmentIds: 'all',
    deactivated: false,
  },
  {
    userId: OMAR,
    name: 'Omar Nasser',
    email: 'omar@x.test',
    departmentIds: [SUPPORT],
    deactivated: false,
  },
  {
    userId: SUE,
    name: 'Sue Park',
    email: 'sue@x.test',
    departmentIds: [SUPPORT],
    deactivated: false,
  },
  { userId: BO, name: 'Bo Lind', email: 'bo@x.test', departmentIds: [BILLING], deactivated: false },
];

const ticketFacts = (overrides: Partial<TicketFacts> = {}): TicketFacts => ({
  id: TICKET,
  departmentId: SUPPORT,
  departmentName: 'Support',
  departmentNameAr: null,
  assigneeId: OMAR,
  teamId: TEAM,
  reference: 'HD-1042',
  subject: 'Refund not received',
  priority: 'urgent',
  contactName: 'Mona Khalil',
  ...overrides,
});

interface Fake {
  readonly repository: NotificationsRepository;
  readonly inserted: NewNotificationRow[];
}

const fakeRepository = ({
  ticket = ticketFacts(),
  message,
  team = [SUE],
  preferences = new Map<string, NotificationPreferences>(),
  delivery,
  subscriptions = [],
  alreadyInserted = false,
}: {
  ticket?: TicketFacts | null;
  message?: MessageFacts;
  team?: string[];
  preferences?: Map<string, NotificationPreferences>;
  delivery?: DeliveryFacts;
  subscriptions?: SubscriptionRow[];
  alreadyInserted?: boolean;
} = {}): Fake => {
  const inserted: NewNotificationRow[] = [];
  const repository = {
    ticket: async () => ticket ?? undefined,
    message: async () => message,
    members: async () => members,
    teamMemberIds: async (_tx: DbTransaction, teamIds: readonly string[]) =>
      teamIds.length === 0 ? [] : team,
    preferencesOf: async () => preferences,
    insert: async (_tx: DbTransaction, rows: readonly NewNotificationRow[]) => {
      inserted.push(...rows);
      return alreadyInserted ? [] : rows.map((_row, index) => `notification-${String(index)}`);
    },
    delivery: async () => delivery,
    subscriptionsOf: async () => subscriptions,
    subscription: async (_tx: DbTransaction, id: string) =>
      subscriptions.find((row) => row.id === id),
  } as unknown as NotificationsRepository;

  return { repository, inserted };
};

/** A transaction that records the outbox rows written through it. */
const recordingTx = () => {
  const outbox: { event: string; payload: unknown }[] = [];
  const tx = {
    insert: () => ({
      values: (values: { event: string; payload: unknown }) => {
        outbox.push(values);
        return { returning: async () => [{ id: OUTBOX }] };
      },
    }),
  } as unknown as DbTransaction;

  return { tx, outbox };
};

const fanOut = async (
  event: string,
  payload: Record<string, unknown>,
  fake: Fake = fakeRepository(),
  pushConfigured = false,
) => {
  const { tx, outbox } = recordingTx();
  await createFanOutHandler({
    repository: fake.repository,
    pushConfigured: async () => pushConfigured,
  })({ outboxId: OUTBOX, brandId: BRAND, event, payload, tx, log: silentLogger });

  return { rows: fake.inserted, outbox };
};

const recipientsOf = (rows: readonly NewNotificationRow[]) => rows.map((row) => row.userId);

describe('planFor', () => {
  it('ignores events it does not consume, a staff reply without a message, and non-public replies', () => {
    expect(planFor('ticket.closed', { ticketId: TICKET })).toBeNull();
    expect(planFor(TICKET_EVENTS.replied, { ticketId: TICKET, departmentId: SUPPORT })).toBeNull();
    expect(
      planFor(TICKET_EVENTS.replied, {
        ticketId: TICKET,
        departmentId: SUPPORT,
        messageId: MESSAGE,
        kind: 'ai',
      }),
    ).toBeNull();
    expect(
      planFor(TICKET_EVENTS.noteAdded, { ticketId: TICKET, departmentId: SUPPORT }),
    ).toBeNull();
  });

  it('refuses a malformed payload from another agent rather than guessing', () => {
    expect(() => planFor(SLA_EVENTS.warning, { ticketId: TICKET, clock: 'lunch' })).toThrow();
  });

  it('consumes the six events of the seam', () => {
    expect(CONSUMED_EVENTS).toEqual([
      'ticket.assigned',
      'ticket.replied',
      'ticket.note_added',
      'sla.warning',
      'sla.breached',
      'ticket.escalated',
    ]);
  });
});

describe('the fan-out handler', () => {
  it('tells the new assignee, with who chose and the channels they prefer', async () => {
    const { rows, outbox } = await fanOut(TICKET_ASSIGNED_EVENT, {
      ticketId: TICKET,
      departmentId: SUPPORT,
      assigneeId: OMAR,
      assignedBy: 'person',
      actorId: LINA,
    });

    expect(rows).toEqual([
      {
        brandId: BRAND,
        userId: OMAR,
        ticketId: TICKET,
        messageId: null,
        kind: 'assigned',
        actorId: LINA,
        detail: { assignedBy: 'person' },
        sourceEventId: OUTBOX,
        inApp: true,
        email: true,
        push: false,
      },
    ]);
    expect(outbox).toEqual([
      expect.objectContaining({
        event: NOTIFICATION_EVENTS.created,
        payload: { notificationId: 'notification-0' },
      }),
    ]);
  });

  it('tells nobody about assigning a ticket to yourself', async () => {
    const { rows } = await fanOut(TICKET_ASSIGNED_EVENT, {
      ticketId: TICKET,
      departmentId: SUPPORT,
      assigneeId: OMAR,
      assignedBy: 'person',
      actorId: OMAR,
    });

    expect(rows).toEqual([]);
  });

  it('tells the assignee when the contact replies, and nobody when a colleague does', async () => {
    const reply = (authorType: string) =>
      fanOut(
        TICKET_EVENTS.replied,
        { ticketId: TICKET, departmentId: SUPPORT, messageId: MESSAGE, seq: 2, kind: 'public' },
        fakeRepository({
          message: {
            id: MESSAGE,
            kind: 'public',
            authorType,
            authorId: authorType === 'staff' ? LINA : 'contact-1',
            bodyText: 'Any news?',
            channel: 'email',
          },
        }),
      );

    expect(recipientsOf((await reply('contact')).rows)).toEqual([OMAR]);
    expect((await reply('staff')).rows).toEqual([]);
  });

  it('tells everyone a note mentions who can see the ticket, never its author', async () => {
    const { rows } = await fanOut(
      TICKET_EVENTS.noteAdded,
      { ticketId: TICKET, departmentId: SUPPORT, messageId: MESSAGE, seq: 3, kind: 'note' },
      fakeRepository({
        message: {
          id: MESSAGE,
          kind: 'note',
          authorType: 'staff',
          authorId: LINA,
          bodyText: '@Omar @Bo @Lina can you confirm from finance?',
          channel: 'manual',
        },
      }),
    );

    // Bo works Billing and cannot see a Support ticket (DOMAIN-RULES §1.2).
    expect(recipientsOf(rows)).toEqual([OMAR]);
    expect(rows[0]).toMatchObject({ kind: 'mentioned', actorId: LINA, messageId: MESSAGE });
  });

  it('tells the assignee about a warning, with the clock and the step', async () => {
    const { rows } = await fanOut(SLA_EVENTS.warning, {
      ticketId: TICKET,
      clock: 'resolution',
      stepPercent: 80,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        userId: OMAR,
        kind: 'sla_warning',
        detail: { clock: 'resolution', stepPercent: 80 },
        email: false,
      }),
    ]);
  });

  it('tells the team about a breach on a ticket nobody holds', async () => {
    const { rows } = await fanOut(
      SLA_EVENTS.breached,
      { ticketId: TICKET, clock: 'first_response' },
      fakeRepository({ ticket: ticketFacts({ assigneeId: null }) }),
    );

    expect(recipientsOf(rows)).toEqual([SUE]);
  });

  it('tells nobody about a breach on a ticket with neither assignee nor team', async () => {
    const { rows, outbox } = await fanOut(
      SLA_EVENTS.breached,
      { ticketId: TICKET, clock: 'first_response' },
      fakeRepository({ ticket: ticketFacts({ assigneeId: null, teamId: null }) }),
    );

    expect([rows, outbox]).toEqual([[], []]);
  });

  it('tells whoever an escalation names, and falls back to the assignee and team', async () => {
    const named = await fanOut(TICKET_ESCALATED_EVENT, {
      ticketId: TICKET,
      userIds: [LINA],
      teamIds: [TEAM],
      stepPercent: 120,
      clock: 'resolution',
    });
    const unnamed = await fanOut(TICKET_ESCALATED_EVENT, { ticketId: TICKET });

    expect(recipientsOf(named.rows)).toEqual([LINA, SUE]);
    expect(named.rows[0]?.detail).toEqual({ clock: 'resolution', stepPercent: 120 });
    expect(recipientsOf(unnamed.rows)).toEqual([OMAR, SUE]);
  });

  it('writes no row for somebody who turned every channel off', async () => {
    const preferences = new Map([
      [
        OMAR,
        {
          ...NOTIFICATION_PREFERENCE_DEFAULTS,
          sla_warning: { inApp: false, email: false, push: false },
        },
      ],
    ]);
    const { rows } = await fanOut(
      SLA_EVENTS.warning,
      { ticketId: TICKET, clock: 'resolution', stepPercent: 80 },
      fakeRepository({ preferences }),
    );

    expect(rows).toEqual([]);
  });

  it('asks for push only on an install that can send it', async () => {
    const payload = { ticketId: TICKET, clock: 'first_response' };

    expect((await fanOut(SLA_EVENTS.breached, payload, fakeRepository(), true)).rows[0]?.push).toBe(
      true,
    );
    expect(
      (await fanOut(SLA_EVENTS.breached, payload, fakeRepository(), false)).rows[0]?.push,
    ).toBe(false);
  });

  it('does nothing for a ticket that is gone, or a redelivery whose rows exist', async () => {
    const payload = { ticketId: TICKET, clock: 'first_response' };

    expect(
      (await fanOut(SLA_EVENTS.breached, payload, fakeRepository({ ticket: null }))).rows,
    ).toEqual([]);
    expect(
      (await fanOut(SLA_EVENTS.breached, payload, fakeRepository({ alreadyInserted: true })))
        .outbox,
    ).toEqual([]);
  });
});

const delivered = (overrides: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  id: NOTIFICATION,
  kind: 'sla_breached',
  userId: OMAR,
  userName: 'Omar Nasser',
  userEmail: 'omar@x.test',
  userLocale: 'en',
  userDeactivated: false,
  ticketId: TICKET,
  messageId: null,
  actorName: null,
  detail: { clock: 'first_response' },
  inApp: true,
  email: true,
  push: true,
  createdAt: new Date('2026-09-27T10:00:00Z'),
  ...overrides,
});

const subscription: SubscriptionRow = {
  id: SUBSCRIPTION,
  userId: OMAR,
  endpoint: 'https://push.example.com/a',
  p256dh: 'key',
  auth: 'auth',
  label: 'Chrome on macOS',
  createdAt: new Date(),
};

const deliver = async (fake: Fake) => {
  const frames: RealtimeBroadcastInput[] = [];
  const emails: [string, NotifyEmailPayload][] = [];
  const pushes: [string, NotifyPushPayload][] = [];

  await createNotificationCreatedHandler({
    repository: fake.repository,
    broadcast: { emit: async (input) => void frames.push(input) },
    queue: {
      addEmail: async (jobId, payload) => void emails.push([jobId, payload]),
      addPush: async (jobId, payload) => void pushes.push([jobId, payload]),
    },
  })({
    outboxId: OUTBOX,
    brandId: BRAND,
    event: NOTIFICATION_EVENTS.created,
    payload: { notificationId: NOTIFICATION },
    tx: {} as DbTransaction,
    log: silentLogger,
  });

  return { frames, emails, pushes };
};

describe('the notification.created handler', () => {
  it('rings the bell in the recipient room, and queues one email and one push per browser', async () => {
    const { frames, emails, pushes } = await deliver(
      fakeRepository({ delivery: delivered(), subscriptions: [subscription] }),
    );

    expect(frames).toEqual([
      {
        rooms: [userRoom(OMAR)],
        event: REALTIME_EVENTS.notificationCreated,
        data: { brandId: BRAND, notificationId: NOTIFICATION },
        seq: null,
      },
    ]);
    expect(emails).toEqual([
      [emailJobId(NOTIFICATION), { brandId: BRAND, notificationId: NOTIFICATION }],
    ]);
    expect(pushes).toEqual([
      [
        pushJobId(SUBSCRIPTION, NOTIFICATION),
        { brandId: BRAND, subscriptionId: SUBSCRIPTION, notificationId: NOTIFICATION },
      ],
    ]);
    // BullMQ refuses a custom job id with a colon in it.
    expect(emailJobId(NOTIFICATION)).not.toContain(':');
  });

  it('uses only the channels the row was made with', async () => {
    const { frames, emails, pushes } = await deliver(
      fakeRepository({
        delivery: delivered({ inApp: false, email: false, push: false }),
        subscriptions: [subscription],
      }),
    );

    expect([frames, emails, pushes]).toEqual([[], [], []]);
  });

  it('does nothing for a recipient deactivated since, or a row that is gone', async () => {
    const deactivated = await deliver(
      fakeRepository({ delivery: delivered({ userDeactivated: true }) }),
    );
    const missing = await deliver(fakeRepository());

    expect([deactivated.frames, missing.frames]).toEqual([[], []]);
  });
});

describe('the push test handler', () => {
  const press = async (userId: string) => {
    const pushes: [string, NotifyPushPayload][] = [];
    await createPushTestHandler({
      repository: fakeRepository({ subscriptions: [subscription] }).repository,
      queue: {
        addEmail: async () => undefined,
        addPush: async (jobId, payload) => void pushes.push([jobId, payload]),
      },
    })({
      outboxId: OUTBOX,
      brandId: BRAND,
      event: NOTIFICATION_EVENTS.pushTest,
      payload: { userId, subscriptionId: SUBSCRIPTION },
      tx: {} as DbTransaction,
      log: silentLogger,
    });

    return pushes;
  };

  it('pushes to the browser of the person who pressed it', async () => {
    expect(await press(OMAR)).toEqual([
      [
        pushJobId(SUBSCRIPTION, OUTBOX),
        { brandId: BRAND, subscriptionId: SUBSCRIPTION, testId: OUTBOX },
      ],
    ]);
  });

  it('pushes nothing to a browser that has changed hands since', async () => {
    expect(await press(LINA)).toEqual([]);
  });
});
