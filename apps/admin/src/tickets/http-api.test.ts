import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
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

  it('escapes the ids it puts in a path', async () => {
    fetchMock.mockResolvedValue(json({ activity: [] }));

    await api.activity('a/b', 'c d');

    expect(lastUrl()).toBe('/api/brands/a%2Fb/tickets/c%20d/activity');
  });
});

describe('the fixtures these tests are built on', () => {
  it('anchor every date to one instant, so nothing depends on the clock', () => {
    expect(Date.parse(testTicket().updatedAt)).toBeLessThan(NOW);
  });
});
