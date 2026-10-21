import { BULK_OPERATIONS_PER_MINUTE, type BulkChanges, UNMERGE_WINDOW_MS } from '@helpdock/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_CONTACT_MONA } from '../contacts/mock-api.js';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../staff/mock-api.js';
import { TicketLifecycleError } from './api.js';
import {
  MOCK_STATUS_AWAITING,
  MOCK_STATUS_CLOSED,
  MOCK_STATUS_MERGED,
  MOCK_STATUS_SNOOZED,
  MOCK_TICKET_CLOSED,
  MOCK_TICKET_REFUND,
  MOCK_TICKET_SIGN_IN,
  MOCK_TICKET_TRANSCRIPT,
  MOCK_TICKET_VAT,
  MockTicketsApi,
} from './mock-api.js';

/**
 * The fixture is what every screen test and both mock Playwright projects run
 * against, so what is asserted here is the behaviour the screens are built on:
 * the filters, the keyset cursor, the `?after=` catch-up and the `clientId`
 * de-duplication of DOMAIN-RULES §7.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const [SUPPORT, BILLING, ONBOARDING] = MOCK_DEPARTMENTS;

describe('MockTicketsApi', () => {
  let api: MockTicketsApi;

  beforeEach(() => {
    api = new MockTicketsApi();
  });

  it('names each row’s contact the way the api embeds it (M1-15)', async () => {
    const { tickets } = await api.list(BRAND, { limit: 100 });

    const withContact = tickets.find((ticket) => ticket.contactId === MOCK_CONTACT_MONA);
    expect(withContact?.contact).toEqual({ id: MOCK_CONTACT_MONA, name: 'Mona Khalil' });
    expect(
      tickets
        .filter((ticket) => ticket.contactId === null)
        .every((ticket) => ticket.contact === null),
    ).toBe(true);
  });

  it('asks the contact fixture it was given, so a contact made this session is named', async () => {
    const named = new MockTicketsApi(undefined, Date.now(), undefined, (id) =>
      id === MOCK_CONTACT_MONA ? 'Mona K.' : undefined,
    );

    // The refund ticket is Mona's.
    const { ticket } = await named.ticket(BRAND, MOCK_TICKET_REFUND);
    expect(ticket.contact).toEqual({ id: MOCK_CONTACT_MONA, name: 'Mona K.' });
  });

  it('answers a contact’s timeline from its tickets, newest first, with the hidden count', () => {
    const history = api.contactHistory(MOCK_CONTACT_MONA);

    expect(history.items.map((item) => [item.id, item.reference, item.statusId])).toEqual([
      [MOCK_TICKET_REFUND, 'HD-1042', expect.any(String)],
      [MOCK_TICKET_CLOSED, 'HD-1030', MOCK_STATUS_CLOSED],
    ]);
    expect(history.items[1]?.departmentName).toBe(BILLING?.name);
    expect(history.visibleCount).toBe(2);
    expect(history.hiddenCount).toBe(2);
    expect(api.contactHistory('0192c3f0-1a2b-7c3d-8e4f-0000000000ff')).toEqual({
      items: [],
      visibleCount: 0,
      hiddenCount: 0,
    });
  });

  it('leaves a contact’s spam out of its timeline, as the api does', async () => {
    await api.markSpam(BRAND, MOCK_TICKET_REFUND, { blockSender: false });

    const history = api.contactHistory(MOCK_CONTACT_MONA);

    expect(history.items.map((item) => item.id)).toEqual([MOCK_TICKET_CLOSED]);
    expect(history.visibleCount).toBe(1);
  });

  it('seeds the seven statuses every brand is created with', async () => {
    const { statuses } = await api.statuses(BRAND);

    expect(statuses.map((status) => status.name)).toEqual([
      'Open',
      'Awaiting customer',
      'Escalated',
      'Closed',
      'Spam',
      'Merged',
      'Snoozed',
    ]);
    expect(statuses.every((status) => status.isSystem)).toBe(true);
  });

  it('lists the brand’s tickets, newest movement first', async () => {
    const { tickets } = await api.list(BRAND);

    expect(tickets).toHaveLength(9);
    expect(tickets[0]?.number).toBe(1042);
  });

  it('spreads the tickets across the departments', async () => {
    const support = await api.list(BRAND, { departmentId: [SUPPORT?.id ?? ''] });
    const billing = await api.list(BRAND, { departmentId: [BILLING?.id ?? ''] });
    const onboarding = await api.list(BRAND, { departmentId: [ONBOARDING?.id ?? ''] });

    // Support holds the WhatsApp and Messenger tickets, Onboarding the Instagram one (M10-08).
    expect(support.tickets).toHaveLength(6);
    expect(billing.tickets).toHaveLength(2);
    expect(onboarding.tickets).toHaveLength(1);
  });

  it('filters by system state, priority and assignee together', async () => {
    const { tickets } = await api.list(BRAND, {
      systemState: ['open'],
      priority: ['urgent'],
      assigneeId: [MOCK_SELF_ID],
    });

    expect(tickets.map((ticket) => ticket.id)).toEqual([MOCK_TICKET_REFUND]);
  });

  it('treats `unassigned` as a value of the assignee filter', async () => {
    const { tickets } = await api.list(BRAND, { assigneeId: ['unassigned'] });

    expect(tickets.every((ticket) => ticket.assigneeId === null)).toBe(true);
    expect(tickets).toHaveLength(2);
  });

  it('searches the subject and the reference', async () => {
    expect((await api.list(BRAND, { q: 'refund' })).tickets).toHaveLength(1);
    expect((await api.list(BRAND, { q: 'HD-1035' })).tickets).toHaveLength(1);
    expect((await api.list(BRAND, { q: 'nothing at all' })).tickets).toHaveLength(0);
  });

  describe('a term that names a ticket (#221)', () => {
    const MY_OPEN = { assigneeId: ['me'], systemState: ['open', 'on_hold', 'escalated'] } as const;

    it.each(['HD-1030', 'hd-1030', '#1030', '1030'])(
      'finds closed HD-1030 from an open-only view by %s',
      async (q) => {
        const { tickets } = await api.list(BRAND, { ...MY_OPEN, q });

        expect(tickets.map((ticket) => ticket.id)).toEqual([MOCK_TICKET_CLOSED]);
      },
    );

    it('keeps a word of its subject inside the view', async () => {
      expect((await api.list(BRAND, { ...MY_OPEN, q: 'duplicate' })).tickets).toEqual([]);
    });

    it('lists the named ticket ahead of the view’s own matches', async () => {
      // Updated just now, so it would sort first by last update.
      const mention = await api.create(BRAND, {
        subject: 'Follow-up on 1030',
        bodyHtml: '<p>Same charge again</p>',
        departmentId: SUPPORT?.id ?? '',
        channel: 'manual',
        assigneeId: MOCK_SELF_ID,
      });

      const { tickets } = await api.list(BRAND, { ...MY_OPEN, q: '1030' });

      expect(tickets.map((ticket) => ticket.id)).toEqual([MOCK_TICKET_CLOSED, mention.ticket.id]);
    });
  });

  it('pages by cursor, and says so by handing one back', async () => {
    const first = await api.list(BRAND, { limit: 5 });
    expect(first.tickets).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();

    const second = await api.list(BRAND, { limit: 5, cursor: first.nextCursor ?? '' });
    expect(second.tickets).toHaveLength(4);
    expect(second.nextCursor).toBeNull();

    const ids = new Set([...first.tickets, ...second.tickets].map((ticket) => ticket.id));
    expect(ids.size).toBe(9);
  });

  it('sorts by number when asked', async () => {
    const { tickets } = await api.list(BRAND, { sort: 'number', direction: 'asc' });

    expect(tickets.map((ticket) => ticket.number)).toEqual([
      1028, 1030, 1035, 1036, 1038, 1039, 1040, 1041, 1042,
    ]);
  });

  it('answers a ticket with the start of its thread and its activity', async () => {
    const detail = await api.ticket(BRAND, MOCK_TICKET_REFUND);

    expect(detail.ticket.subject).toContain('Refund');
    expect(detail.messages.messages.map((message) => message.kind)).toEqual([
      'public',
      'ai',
      'note',
      'public',
    ]);
    expect(detail.activity.map((row) => row.action)).toContain('ticket.updated');
  });

  it('refuses a ticket it does not hold, the way a policy would', async () => {
    await expect(api.ticket(BRAND, '0192c3f0-1a2b-7c3d-8e4f-0000000009ff')).rejects.toThrow();
  });

  it('answers only what is after the seq a client holds', async () => {
    const page = await api.messages(BRAND, MOCK_TICKET_REFUND, 2);

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(page.nextAfter).toBeNull();
  });

  it('creates a ticket with its first message and an activity row', async () => {
    const created = await api.create(BRAND, {
      subject: 'Typed in by hand',
      bodyHtml: '<p>Hello</p>',
      departmentId: SUPPORT?.id ?? '',
      priority: 'high',
      channel: 'manual',
      contactId: MOCK_CONTACT_MONA,
    });

    expect(created.ticket.number).toBe(1043);
    expect(created.ticket.status.name).toBe('Open');
    expect(created.messages.messages).toHaveLength(1);
    expect(created.activity[0]?.action).toBe('ticket.created');
    expect((await api.list(BRAND)).tickets).toHaveLength(10);
  });

  it('moves a status, and records the move', async () => {
    const updated = await api.update(BRAND, MOCK_TICKET_REFUND, {
      statusId: MOCK_STATUS_AWAITING,
    });

    expect(updated.status.name).toBe('Awaiting customer');
    const { activity } = await api.activity(BRAND, MOCK_TICKET_REFUND);
    expect(activity.at(-1)).toMatchObject({
      action: 'ticket.status.changed',
      to: { status: 'Awaiting customer' },
    });
  });

  it('stamps a closing status with the moment it closed', async () => {
    const closed = await api.update(BRAND, MOCK_TICKET_VAT, { statusId: MOCK_STATUS_CLOSED });

    expect(closed.closedAt).not.toBeNull();
  });

  it('records a field change as `ticket.updated`', async () => {
    await api.update(BRAND, MOCK_TICKET_REFUND, { priority: 'low' });
    const { activity } = await api.activity(BRAND, MOCK_TICKET_REFUND);

    expect(activity.at(-1)?.action).toBe('ticket.updated');
  });

  it('checks custom values against the brand’s ticket fields and merges them in', async () => {
    const updated = await api.update(BRAND, MOCK_TICKET_REFUND, {
      custom: { order_id: ' ORD-9 ', renews_on: '2026-10-01', tier: null },
    });

    expect(updated.custom).toEqual({ order_id: 'ORD-9', renews_on: '2026-10-01' });
    await expect(
      api.update(BRAND, MOCK_TICKET_REFUND, { custom: { tier: 'platinum' } }),
    ).rejects.toThrow(/custom/);
    await expect(
      api.update(BRAND, MOCK_TICKET_REFUND, { custom: { nobody_defined: 'x' } }),
    ).rejects.toThrow(/custom/);
  });

  it('replaces a ticket’s tags with the set asked for, in the brand’s order (M1-15)', async () => {
    const { tags } = await api.setTags(BRAND, MOCK_TICKET_REFUND, [
      '0192c3f0-1a2b-7c3d-8e4f-000000000103',
      '0192c3f0-1a2b-7c3d-8e4f-000000000101',
    ]);

    expect(tags.map((tag) => tag.name)).toEqual(['Refund', 'Bug']);
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.tags).toEqual(tags);
    const { activity } = await api.activity(BRAND, MOCK_TICKET_REFUND);
    expect(activity.at(-1)?.action).toBe('ticket.tags.changed');
  });

  it('refuses a tag the brand no longer has, as the api does', async () => {
    const { ticket } = await api.ticket(BRAND, MOCK_TICKET_TRANSCRIPT);

    await expect(
      api.setTags(
        BRAND,
        MOCK_TICKET_TRANSCRIPT,
        (ticket.tags ?? []).map((tag) => tag.id),
      ),
    ).rejects.toThrow(/No such tag/);
  });

  it('gives a reply the next seq and bumps the ticket', async () => {
    const before = await api.ticket(BRAND, MOCK_TICKET_REFUND);
    const reply = await api.reply(BRAND, MOCK_TICKET_REFUND, {
      kind: 'public',
      bodyHtml: '<p>On its way.</p>',
      clientId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
    });

    expect(reply.seq).toBe(5);
    expect(reply.authorType).toBe('staff');
    const after = await api.ticket(BRAND, MOCK_TICKET_REFUND);
    expect(after.ticket.updatedAt > before.ticket.updatedAt).toBe(true);
  });

  it('hands the first message back when the same clientId is posted twice', async () => {
    const request = {
      kind: 'public' as const,
      bodyHtml: '<p>Once.</p>',
      clientId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
    };
    const first = await api.reply(BRAND, MOCK_TICKET_REFUND, request);
    const retry = await api.reply(BRAND, MOCK_TICKET_REFUND, request);

    expect(retry).toEqual(first);
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).messages.messages).toHaveLength(5);
  });

  it('files a note as a note, on the manual channel', async () => {
    const note = await api.reply(BRAND, MOCK_TICKET_REFUND, {
      kind: 'note',
      bodyHtml: '<p>For the team.</p>',
    });

    expect(note).toMatchObject({ kind: 'note', channel: 'manual' });
    const { activity } = await api.activity(BRAND, MOCK_TICKET_REFUND);
    expect(activity.at(-1)?.action).toBe('ticket.note_added');
  });
});

describe('MockTicketsApi, merge and split (M1-09)', () => {
  let api: MockTicketsApi;

  beforeEach(() => {
    api = new MockTicketsApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the secondary as Merged and shows it inline in the primary', async () => {
    const result = await api.merge(BRAND, MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_VAT });

    expect(result.secondary.status.id).toBe(MOCK_STATUS_MERGED);
    expect(result.secondary.mergedIntoId).toBe(MOCK_TICKET_VAT);
    expect(result.secondary.departmentId).toBe(result.primary.departmentId);

    const primary = await api.ticket(BRAND, MOCK_TICKET_VAT);
    const block = primary.merged?.[0];
    expect(block?.id).toBe(MOCK_TICKET_REFUND);
    expect(primary.messages.messages.map((message) => message.id)).toContain(
      block?.systemMessageId,
    );
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).mergedInto?.id).toBe(MOCK_TICKET_VAT);
  });

  it('refuses what the api refuses, with the same reasons', async () => {
    await expect(
      api.merge(BRAND, MOCK_TICKET_VAT, { primaryTicketId: MOCK_TICKET_VAT }),
    ).rejects.toEqual(new TicketLifecycleError('merge-into-self'));

    await api.merge(BRAND, MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_VAT });

    await expect(
      api.merge(BRAND, MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_CLOSED }),
    ).rejects.toEqual(new TicketLifecycleError('ticket-merged'));
    await expect(
      api.merge(BRAND, MOCK_TICKET_SIGN_IN, { primaryTicketId: MOCK_TICKET_REFUND }),
    ).rejects.toEqual(new TicketLifecycleError('merge-into-merged'));
    await expect(api.unmerge(BRAND, MOCK_TICKET_VAT)).rejects.toEqual(
      new TicketLifecycleError('ticket-not-merged'),
    );
  });

  it('restores the previous status on unmerge, and refuses one after 24 hours', async () => {
    const before = await api.ticket(BRAND, MOCK_TICKET_REFUND);
    await api.merge(BRAND, MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_VAT });

    const undone = await api.unmerge(BRAND, MOCK_TICKET_REFUND);
    expect(undone.secondary.status.id).toBe(before.ticket.status.id);
    expect((await api.ticket(BRAND, MOCK_TICKET_VAT)).merged).toEqual([]);

    await api.merge(BRAND, MOCK_TICKET_REFUND, { primaryTicketId: MOCK_TICKET_VAT });
    vi.useFakeTimers({ now: Date.now() + UNMERGE_WINDOW_MS });
    expect((await api.ticket(BRAND, MOCK_TICKET_VAT)).merged?.[0]?.unmergeableUntil).toBeNull();
    await expect(api.unmerge(BRAND, MOCK_TICKET_REFUND)).rejects.toEqual(
      new TicketLifecycleError('merge-window-closed'),
    );
  });

  it('copies the chosen messages onto a new ticket and links the two', async () => {
    const [first] = (await api.ticket(BRAND, MOCK_TICKET_REFUND)).messages.messages;

    const created = await api.split(BRAND, MOCK_TICKET_REFUND, {
      messageIds: [first?.id ?? ''],
      subject: 'The return label',
      departmentId: BILLING?.id ?? '',
    });

    expect(created.ticket).toMatchObject({
      number: 1043,
      splitFromId: MOCK_TICKET_REFUND,
      departmentId: BILLING?.id,
    });
    expect(created.messages.messages[0]?.bodyText).toBe(first?.bodyText);
    expect(created.messages.messages[0]?.attachments).toHaveLength(1);
    expect(created.related).toEqual([
      expect.objectContaining({ visible: true, relation: 'splitFrom', id: MOCK_TICKET_REFUND }),
    ]);
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).related).toEqual([
      expect.objectContaining({ visible: true, relation: 'splitTo', id: created.ticket.id }),
    ]);
  });

  it('refuses a message that is not on the ticket', async () => {
    await expect(
      api.split(BRAND, MOCK_TICKET_REFUND, {
        messageIds: [MOCK_TICKET_VAT],
        subject: 'Nope',
        departmentId: SUPPORT?.id ?? '',
      }),
    ).rejects.toThrow();
  });
});

describe('SLA due ordering', () => {
  it('orders oldest breaches, then upcoming clocks, then no-clock tickets with stable ties', async () => {
    const api = new MockTicketsApi();
    const { tickets } = await api.list(BRAND, { sort: 'slaDue', direction: 'asc' });
    expect(tickets.slice(0, 4).map((ticket) => ticket.number)).toEqual([1028, 1042, 1035, 1041]);
    const due = tickets.map((ticket) =>
      ticket.status.pausesSla || ticket.status.systemState === 'closed'
        ? null
        : ([ticket.firstResponseDueAt, ticket.resolutionDueAt]
            .filter((at): at is string => at !== null)
            .sort()[0] ?? null),
    );
    expect(due.filter((at) => at !== null)).toEqual(due.filter((at) => at !== null).sort());
    const tail = due.indexOf(null);
    expect(tail).toBeGreaterThan(0);
    expect(due.slice(tail).every((at) => at === null)).toBe(true);
    expect(Date.parse(due[0] ?? '')).toBeLessThan(Date.now());
    expect(due.some((at) => at !== null && Date.parse(at) > Date.now())).toBe(true);
  });
});

describe('snooze (M14-02)', () => {
  const hoursAhead = (hours: number): string =>
    new Date(Date.now() + hours * 3_600_000).toISOString();

  it('snoozes into the Snoozed status, remembers who, and leaves the default list and the named search alone', async () => {
    const api = new MockTicketsApi();
    const until = hoursAhead(4);

    const snoozed = await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: until });

    expect(snoozed).toMatchObject({
      snoozedUntil: until,
      snoozedBy: MOCK_SELF_ID,
      status: { id: MOCK_STATUS_SNOOZED },
    });
    const everywhere = await api.list(BRAND, { limit: 100 });
    expect(everywhere.tickets.map((ticket) => ticket.id)).not.toContain(MOCK_TICKET_REFUND);
    const only = await api.list(BRAND, { snoozed: 'only', limit: 100 });
    expect(only.tickets.map((ticket) => ticket.id)).toEqual([MOCK_TICKET_REFUND]);
    const included = await api.list(BRAND, { snoozed: 'include', limit: 100 });
    expect(included.tickets.map((ticket) => ticket.id)).toContain(MOCK_TICKET_REFUND);
    // #221: a term that names one ticket finds it whatever its state.
    const named = await api.list(BRAND, { q: 'HD-1042' });
    expect(named.tickets[0]?.id).toBe(MOCK_TICKET_REFUND);
  });

  it('wakes into the status it had before, and says so in the thread', async () => {
    const api = new MockTicketsApi();
    const before = (await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.status.id;
    await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: hoursAhead(4) });

    const woke = await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: null });

    expect(woke.snoozedUntil).toBeNull();
    expect(woke.status.id).toBe(before);
    const actions = (await api.activity(BRAND, MOCK_TICKET_REFUND)).activity.map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['ticket.snoozed', 'ticket.woke']));
  });

  it('waking a ticket that is not asleep changes nothing', async () => {
    const api = new MockTicketsApi();
    const before = (await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket;

    const same = await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: null });

    expect(same.status.id).toBe(before.status.id);
    expect(same.snoozedUntil ?? null).toBeNull();
  });

  it('wakes when any other status is picked', async () => {
    const api = new MockTicketsApi();
    await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: hoursAhead(4) });

    const moved = await api.update(BRAND, MOCK_TICKET_REFUND, { statusId: MOCK_STATUS_AWAITING });

    expect(moved.snoozedUntil).toBeNull();
    expect(moved.status.id).toBe(MOCK_STATUS_AWAITING);
    const reasons = (await api.activity(BRAND, MOCK_TICKET_REFUND)).activity
      .filter((entry) => entry.action === 'ticket.woke')
      .map((entry) => entry.to?.reason);
    expect(reasons).toEqual(['status_changed']);
  });

  it('refuses a bare Snoozed status, a closed ticket, and a time outside five minutes to ninety days', async () => {
    const api = new MockTicketsApi();

    await expect(
      api.update(BRAND, MOCK_TICKET_REFUND, { statusId: MOCK_STATUS_SNOOZED }),
    ).rejects.toMatchObject({ reason: 'snooze-requires-time' });
    await expect(
      api.update(BRAND, MOCK_TICKET_CLOSED, { snoozedUntil: hoursAhead(4) }),
    ).rejects.toMatchObject({ reason: 'ticket-closed' });
    await expect(
      api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: hoursAhead(0.01) }),
    ).rejects.toThrow('between 5 minutes and 90 days');
    await expect(
      api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: hoursAhead(24 * 91) }),
    ).rejects.toThrow('between 5 minutes and 90 days');
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.status.id).not.toBe(
      MOCK_STATUS_SNOOZED,
    );
  });

  it('moves the time of a snooze that is already set without forgetting the status before it', async () => {
    const api = new MockTicketsApi();
    const before = (await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.status.id;
    await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: hoursAhead(4) });
    const later = hoursAhead(30);

    const moved = await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: later });
    const woke = await api.update(BRAND, MOCK_TICKET_REFUND, { snoozedUntil: null });

    expect(moved.snoozedUntil).toBe(later);
    expect(woke.status.id).toBe(before);
    expect(before).not.toBe(MOCK_STATUS_SNOOZED);
  });
});

describe('bulk edit (M14-04)', () => {
  const ids = [MOCK_TICKET_REFUND, MOCK_TICKET_SIGN_IN];
  const preview = (api: MockTicketsApi, changes: BulkChanges, ticketIds: string[] = ids) =>
    api.bulk(BRAND, { ticketIds, changes, mode: 'preview' });

  it('previews without writing, and says per ticket what would move', async () => {
    const api = new MockTicketsApi();

    const response = await preview(api, { priority: 'low' });

    expect(response.counts).toEqual({ willChange: 2, unchanged: 0, refused: 0, notFound: 0 });
    expect(response.results.map((result) => result.fields)).toEqual([['priority'], ['priority']]);
    expect(response.operationId).toBeNull();
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.priority).not.toBe('low');
  });

  it('reports a closed ticket as unchanged by a close, refused by a snooze, and a stranger as not found', async () => {
    const api = new MockTicketsApi();

    const closing = await preview(api, { close: true }, [MOCK_TICKET_CLOSED]);
    const snoozing = await preview(
      api,
      { snoozedUntil: new Date(Date.now() + 3_600_000 * 4).toISOString() },
      [MOCK_TICKET_CLOSED],
    );
    const missing = await preview(api, { close: true }, ['0192c3f0-1a2b-7c3d-8e4f-0000000fffff']);

    expect(closing.results[0]?.outcome).toBe('unchanged');
    expect(snoozing.results[0]).toMatchObject({ outcome: 'refused', code: 'ticket-closed' });
    expect(missing.results[0]?.outcome).toBe('not_found');
  });

  it('applies the ids the preview named, and Undo puts the old values back', async () => {
    const api = new MockTicketsApi();
    const before = (await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.priority;

    const applied = await api.bulk(BRAND, {
      ticketIds: ids,
      changes: { priority: 'low' },
      mode: 'apply',
      expect: ids,
    });
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.priority).toBe('low');
    expect(applied.operationId).not.toBeNull();
    expect(Date.parse(applied.undoUntil ?? '')).toBeGreaterThan(Date.now());

    const undone = await api.undoBulk(BRAND, applied.operationId ?? '');

    expect(undone.results.map((result) => result.outcome)).toEqual(['reverted', 'reverted']);
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.priority).toBe(before);
  });

  it('answers bulk-changed when the tickets that would change are not the ones the preview named', async () => {
    const api = new MockTicketsApi();

    await expect(
      api.bulk(BRAND, {
        ticketIds: ids,
        changes: { priority: 'low' },
        mode: 'apply',
        expect: [MOCK_TICKET_REFUND],
      }),
    ).rejects.toEqual(new TicketLifecycleError('bulk-changed'));
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.priority).not.toBe('low');
  });

  it('plays its one scripted race: a colleague closes HD-1035 while a close that names it is applied', async () => {
    const api = new MockTicketsApi();
    const named = [MOCK_TICKET_REFUND, MOCK_TICKET_VAT];

    const attempt = (): Promise<unknown> =>
      api.bulk(BRAND, { ticketIds: named, changes: { close: true }, mode: 'apply', expect: named });

    await expect(attempt()).rejects.toEqual(new TicketLifecycleError('bulk-changed'));
    const fresh = await preview(api, { close: true }, named);
    expect(fresh.results.map((result) => result.outcome)).toEqual(['will_change', 'unchanged']);
    // Once only: the second time it is an ordinary stale apply that now names a ticket that cannot change.
    await expect(attempt()).rejects.toEqual(new TicketLifecycleError('bulk-changed'));
  });

  it('keeps a field somebody changed since, and says so', async () => {
    const api = new MockTicketsApi();
    const applied = await api.bulk(BRAND, {
      ticketIds: [MOCK_TICKET_REFUND],
      changes: { priority: 'low' },
      mode: 'apply',
      expect: [MOCK_TICKET_REFUND],
    });
    await api.update(BRAND, MOCK_TICKET_REFUND, { priority: 'high' });

    const undone = await api.undoBulk(BRAND, applied.operationId ?? '');

    expect(undone.results[0]).toMatchObject({ outcome: 'kept', kept: ['priority'], reverted: [] });
    expect((await api.ticket(BRAND, MOCK_TICKET_REFUND)).ticket.priority).toBe('high');
  });

  it('puts tags back as a set', async () => {
    const api = new MockTicketsApi();
    const tagId = '0192c3f0-1a2b-7c3d-8e4f-000000000102';
    const held =
      (await api.ticket(BRAND, MOCK_TICKET_SIGN_IN)).ticket.tags?.map((tag) => tag.id) ?? [];
    const applied = await api.bulk(BRAND, {
      ticketIds: [MOCK_TICKET_SIGN_IN],
      changes: { addTagIds: [tagId] },
      mode: 'apply',
      expect: [MOCK_TICKET_SIGN_IN],
    });
    expect(
      (await api.ticket(BRAND, MOCK_TICKET_SIGN_IN)).ticket.tags?.map((tag) => tag.id),
    ).toContain(tagId);

    await api.undoBulk(BRAND, applied.operationId ?? '');

    expect(
      (await api.ticket(BRAND, MOCK_TICKET_SIGN_IN)).ticket.tags?.map((tag) => tag.id),
    ).toEqual(held);
  });

  it('refuses a second undo and an undo after the sixty seconds', async () => {
    vi.useFakeTimers();
    try {
      const api = new MockTicketsApi();
      const applied = await api.bulk(BRAND, {
        ticketIds: ids,
        changes: { priority: 'low' },
        mode: 'apply',
        expect: ids,
      });
      await api.undoBulk(BRAND, applied.operationId ?? '');
      await expect(api.undoBulk(BRAND, applied.operationId ?? '')).rejects.toEqual(
        new TicketLifecycleError('bulk-already-undone'),
      );

      const late = await api.bulk(BRAND, {
        ticketIds: ids,
        changes: { priority: 'low' },
        mode: 'apply',
        expect: ids,
      });
      vi.advanceTimersByTime(61_000);
      await expect(api.undoBulk(BRAND, late.operationId ?? '')).rejects.toEqual(
        new TicketLifecycleError('bulk-undo-expired'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 429 once twenty applies have been made in a minute, previews apart', async () => {
    const api = new MockTicketsApi();
    const apply = (priority: 'low' | 'high') =>
      api.bulk(BRAND, {
        ticketIds: [MOCK_TICKET_REFUND],
        changes: { priority },
        mode: 'apply',
        expect: [MOCK_TICKET_REFUND],
      });

    for (let n = 0; n < BULK_OPERATIONS_PER_MINUTE; n += 1) {
      await apply(n % 2 === 0 ? 'low' : 'high');
    }

    await expect(apply('low')).rejects.toMatchObject({ code: 'rate-limited', status: 429 });
    await expect(preview(api, { priority: 'low' })).resolves.toMatchObject({ mode: 'preview' });
  });

  it('will not undo an operation it never made', async () => {
    await expect(new MockTicketsApi().undoBulk(BRAND, 'nope')).rejects.toThrow('no such bulk');
  });
});
