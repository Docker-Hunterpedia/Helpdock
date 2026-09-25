import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { TicketLifecycleError } from './api.js';
import { NOW, testMessage, testStatus, testTicket } from './fixtures.js';
import { HttpTicketsApi, listQueryString } from './http-api.js';

/**
 * The adapter against a stubbed `fetch`: what it sends, and that it parses what
 * comes back through the very schema `apps/api` declared the response with.
 * That the endpoints behind it behave is the api's integration suite.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000001042';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpTicketsApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpTicketsApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastUrl = (): string => String(fetchMock.mock.calls.at(-1)?.[0]);
const lastInit = (): RequestInit => (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as RequestInit;

describe('listQueryString', () => {
  it('repeats a key per member, which is what the api coerces to an array', () => {
    expect(listQueryString({ priority: ['high', 'urgent'] })).toBe(
      '?priority=high&priority=urgent',
    );
  });

  it('leaves an empty filter off entirely rather than sending nothing', () => {
    expect(listQueryString({ statusId: [], q: '' })).toBe('');
  });

  it('sends the scalars it was given, and nothing it was not', () => {
    expect(listQueryString({ q: 'refund', limit: 10 })).toBe('?q=refund&limit=10');
  });

  it('is empty for an empty query', () => {
    expect(listQueryString({})).toBe('');
  });
});

describe('HttpTicketsApi', () => {
  it('reads the brand’s statuses', async () => {
    fetchMock.mockResolvedValue(json({ statuses: [testStatus()] }));

    const { statuses } = await api.statuses(BRAND);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/ticket-statuses`);
    expect(statuses[0]?.name).toBe('Open');
  });

  it('reads a list with its filters in the query string', async () => {
    fetchMock.mockResolvedValue(json({ tickets: [testTicket()], nextCursor: null }));

    await api.list(BRAND, { systemState: ['open'], assigneeId: ['unassigned'] });

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets?systemState=open&assigneeId=unassigned`);
  });

  it('reads one ticket, its thread and its activity', async () => {
    fetchMock.mockResolvedValue(
      json({
        ticket: testTicket(),
        messages: { messages: [testMessage({ seq: 1 })], nextAfter: null },
        activity: [],
      }),
    );

    const detail = await api.ticket(BRAND, TICKET);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}`);
    expect(detail.messages.messages[0]?.seq).toBe(1);
  });

  it('catches up from the seq it holds', async () => {
    fetchMock.mockResolvedValue(json({ messages: [], nextAfter: null }));

    await api.messages(BRAND, TICKET, 12);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/messages?after=12`);
  });

  it('asks for everything when it holds nothing', async () => {
    fetchMock.mockResolvedValue(json({ messages: [], nextAfter: null }));

    await api.messages(BRAND, TICKET);

    expect(lastUrl()).toMatch(/after=0$/u);
  });

  it('reads the activity log', async () => {
    fetchMock.mockResolvedValue(json({ activity: [] }));

    await api.activity(BRAND, TICKET);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/activity`);
  });

  it('posts a ticket and its first message', async () => {
    fetchMock.mockResolvedValue(
      json({ ticket: testTicket(), messages: { messages: [], nextAfter: null }, activity: [] }),
    );

    await api.create(BRAND, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
      priority: 'medium',
      channel: 'manual',
    });

    expect(lastInit().method).toBe('POST');
    expect(String(lastInit().body)).toContain('Refund for order 42');
  });

  it('patches only what it was given', async () => {
    fetchMock.mockResolvedValue(json(testTicket({ priority: 'low' })));

    const ticket = await api.update(BRAND, TICKET, { priority: 'low' });

    expect(lastInit().method).toBe('PATCH');
    expect(JSON.parse(String(lastInit().body))).toEqual({ priority: 'low' });
    expect(ticket.priority).toBe('low');
  });

  it('posts a reply with the clientId the composer generated', async () => {
    const clientId = '0192c3f0-1a2b-7c3d-8e4f-0000000000f1';
    fetchMock.mockResolvedValue(json(testMessage({ seq: 5, clientId })));

    const message = await api.reply(BRAND, TICKET, {
      kind: 'public',
      bodyHtml: '<p>On its way.</p>',
      clientId,
    });

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/messages`);
    expect(JSON.parse(String(lastInit().body))).toMatchObject({ kind: 'public', clientId });
    expect(message.seq).toBe(5);
  });

  it('fails here rather than three components deep when a shape is wrong', async () => {
    fetchMock.mockResolvedValue(json({ tickets: [{ id: 'not-a-uuid' }], nextCursor: null }));

    await expect(api.list(BRAND)).rejects.toThrow();
  });

  it('merges this ticket into the one named, and parses both halves (M1-09)', async () => {
    const primaryTicketId = '0192c3f0-1a2b-7c3d-8e4f-000000001035';
    fetchMock.mockResolvedValue(
      json({
        primary: testTicket({ id: primaryTicketId }),
        secondary: testTicket({ mergedIntoId: primaryTicketId }),
      }),
    );

    const result = await api.merge(BRAND, TICKET, { primaryTicketId });

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/merge`);
    expect(lastInit().method).toBe('POST');
    expect(JSON.parse(String(lastInit().body))).toEqual({ primaryTicketId });
    expect(result.secondary.mergedIntoId).toBe(primaryTicketId);
  });

  it('unmerges with an empty post', async () => {
    fetchMock.mockResolvedValue(json({ primary: testTicket(), secondary: testTicket() }));

    await api.unmerge(BRAND, TICKET);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/unmerge`);
    expect(lastInit().method).toBe('POST');
  });

  it('splits and answers with the new ticket', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          ticket: testTicket({ number: 1043, splitFromId: TICKET }),
          messages: { messages: [], nextAfter: null },
          activity: [],
          related: [{ id: TICKET, number: 1042, prefix: 'HD', subject: 'Refund' }],
        },
        201,
      ),
    );

    const created = await api.split(BRAND, TICKET, {
      messageIds: [TICKET],
      subject: 'VAT',
      departmentId: BRAND,
    });

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/split`);
    expect(created.ticket.splitFromId).toBe(TICKET);
    expect(created.related?.[0]?.number).toBe(1042);
  });

  it('turns a refusal the rules make into a reason the screen can read', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 'conflict',
            message: 'no',
            requestId: 'r',
            lifecycle: { reason: 'merge-window-closed' },
          },
        },
        409,
      ),
    );

    await expect(api.unmerge(BRAND, TICKET)).rejects.toEqual(
      new TicketLifecycleError('merge-window-closed'),
    );
  });

  it('escapes the ids it puts in a path', async () => {
    fetchMock.mockResolvedValue(json({ activity: [] }));

    await api.activity('a/b', 'c d');

    expect(lastUrl()).toBe('/api/brands/a%2Fb/tickets/c%20d/activity');
  });
});

describe('spam (M1-11)', () => {
  it('reads what the dialog will offer', async () => {
    fetchMock.mockResolvedValue(
      json({
        sender: { kind: 'email', value: 'spam@promo-deals.biz' },
        offered: true,
        blockable: true,
        blocked: false,
      }),
    );

    const answer = await api.spamSender(BRAND, TICKET);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/spam-sender`);
    expect(answer.sender?.value).toBe('spam@promo-deals.biz');
  });

  it('marks as spam with the checkbox’s answer, and reads the ticket back', async () => {
    fetchMock.mockResolvedValue(json(testTicket({ status: testStatus({ isSpam: true }) }), 201));

    const ticket = await api.markSpam(BRAND, TICKET, { blockSender: true });

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/spam`);
    expect(lastInit().method).toBe('POST');
    expect(JSON.parse(String(lastInit().body))).toEqual({ blockSender: true });
    expect(ticket.status.isSpam).toBe(true);
  });

  it('takes it back out with a DELETE', async () => {
    fetchMock.mockResolvedValue(json(testTicket()));

    await api.unmarkSpam(BRAND, TICKET);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/spam`);
    expect(lastInit().method).toBe('DELETE');
  });
});

describe('HttpTicketsApi.assignable (M1-07)', () => {
  it('reads who the picker may offer for a department', async () => {
    const DEPARTMENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';
    fetchMock.mockResolvedValue(
      json({
        departmentId: DEPARTMENT,
        loadCap: 8,
        agents: [
          {
            userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000b',
            name: 'Omar Nasser',
            presence: 'online',
            openCount: 8,
          },
        ],
      }),
    );

    const list = await api.assignable(BRAND, DEPARTMENT);

    expect(lastUrl()).toBe(`/api/brands/${BRAND}/assignment/${DEPARTMENT}/assignable`);
    expect(list.agents[0]?.openCount).toBe(8);
  });
});

describe('the Time card (M1-12)', () => {
  const ENTRY = '0192c3f0-1a2b-7c3d-8e4f-0000000000e1';
  const list = {
    entries: [
      {
        id: ENTRY,
        ticketId: TICKET,
        userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
        userName: 'Lina Haddad',
        seconds: 1800,
        note: null,
        messageId: null,
        createdAt: new Date(NOW).toISOString(),
      },
    ],
    totalSeconds: 1800,
  };

  it('reads a ticket’s entries', async () => {
    fetchMock.mockResolvedValue(json(list));

    await expect(api.timeEntries(BRAND, TICKET)).resolves.toEqual(list);
    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/time-entries`);
  });

  it('posts a manual entry', async () => {
    fetchMock.mockResolvedValue(json(list));

    await api.logTime(BRAND, TICKET, { seconds: 1800, note: 'Called' });

    expect(lastInit().method).toBe('POST');
    expect(JSON.parse(String(lastInit().body))).toEqual({ seconds: 1800, note: 'Called' });
  });

  it('deletes one entry by id', async () => {
    fetchMock.mockResolvedValue(json({ entries: [], totalSeconds: 0 }));

    await api.deleteTimeEntry(BRAND, TICKET, ENTRY);

    expect(lastInit().method).toBe('DELETE');
    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/time-entries/${ENTRY}`);
  });
});

describe('the fixtures these tests are built on', () => {
  it('anchor every date to one instant, so nothing depends on the clock', () => {
    expect(Date.parse(testTicket().updatedAt)).toBeLessThan(NOW);
  });
});

describe('HttpTicketsApi participants (M1-13)', () => {
  const list = {
    contact: { id: TICKET, name: 'Mona Khalil' },
    ccs: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-0000000cc001',
        contactId: '0192c3f0-1a2b-7c3d-8e4f-0000000cc0c1',
        name: 'finance@acme.de',
        address: 'finance@acme.de',
        source: 'agent',
      },
    ],
    staff: [],
  };

  it('reads, adds and removes a CC on the participants path', async () => {
    fetchMock.mockResolvedValue(json(list));

    await expect(api.participants(BRAND, TICKET)).resolves.toEqual(list);
    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/participants`);

    fetchMock.mockResolvedValue(json(list));
    await api.addCc(BRAND, TICKET, { email: 'finance@acme.de' });
    expect(lastInit().method).toBe('POST');
    expect(JSON.parse(String(lastInit().body))).toEqual({ email: 'finance@acme.de' });

    fetchMock.mockResolvedValue(json(list));
    await api.removeCc(BRAND, TICKET, 'p/1');
    expect(lastInit().method).toBe('DELETE');
    expect(lastUrl()).toBe(`/api/brands/${BRAND}/tickets/${TICKET}/participants/p%2F1`);
  });
});

describe('views (M1-05)', () => {
  const VIEW = '0192c3f0-1a2b-7c3d-8e4f-0000000000f1';
  const view = {
    id: VIEW,
    name: 'VIP refunds',
    nameAr: null,
    visibility: { kind: 'personal' },
    builtIn: null,
    departmentId: null,
    filters: { priority: ['urgent'], sort: 'updatedAt', direction: 'desc' },
    hidden: false,
    sortOrder: 0,
    editable: true,
  };

  it('reads the views and their counts', async () => {
    fetchMock.mockResolvedValueOnce(json({ views: [view] }));
    fetchMock.mockResolvedValueOnce(json({ counts: [{ viewId: VIEW, count: 4, capped: false }] }));

    expect((await api.views(BRAND)).views[0]?.name).toBe('VIP refunds');
    expect((await api.viewCounts(BRAND)).counts[0]?.count).toBe(4);
    expect(lastUrl()).toBe(`/api/brands/${BRAND}/views/counts`);
  });

  it('creates, renames, reorders and deletes', async () => {
    fetchMock.mockResolvedValueOnce(json(view, 201));
    await api.createView(BRAND, { name: 'VIP refunds', filters: { priority: ['urgent'] } });
    expect(lastInit().method).toBe('POST');

    fetchMock.mockResolvedValueOnce(json({ ...view, name: 'VIP' }));
    expect((await api.updateView(BRAND, 'v/1', { name: 'VIP' })).name).toBe('VIP');
    expect(lastUrl()).toBe(`/api/brands/${BRAND}/views/v%2F1`);

    fetchMock.mockResolvedValueOnce(json({ views: [view] }));
    await api.reorderViews(BRAND, [VIEW]);
    expect(lastInit().body).toBe(JSON.stringify({ viewIds: [VIEW] }));

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteView(BRAND, VIEW);
    expect(lastInit().method).toBe('DELETE');
  });

  it('turns a built-in refusal into a reason the screen can read', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 'conflict',
            message: 'no',
            requestId: 'r',
            ticketing: { reason: 'view-is-built-in' },
          },
        },
        409,
      ),
    );

    await expect(api.deleteView(BRAND, VIEW)).rejects.toMatchObject({
      reason: 'view-is-built-in',
    });
  });

  it('sends overdue and `me` like any other filter', () => {
    expect(listQueryString({ assigneeId: ['me'], overdue: true })).toBe(
      '?assigneeId=me&overdue=true',
    );
  });
});
