import type { RetentionUpdateRequest } from '@helpdock/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpTicketingApi } from './http-api.js';
import { MockTicketingApi } from './mock-api.js';

/**
 * The two retention calls of M1-14 on both adapters. Apart from the ticketing
 * suites because they belong to the Brand screen, not the Ticketing one.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const FORM: RetentionUpdateRequest = {
  closedTickets: { kind: 'never' },
  spamTicketDays: 14,
  aiCallDays: 90,
  searchLogDays: 180,
  auditLogDays: 365,
  visitorSessionDays: 30,
};

const overview = {
  settings: FORM,
  preview: {
    closedTickets: null,
    spamTickets: 3,
    aiCalls: null,
    searchLog: null,
    auditLog: 0,
    visitorSessions: null,
  },
  lastRun: null,
};

describe('HttpTicketingApi retention', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: HttpTicketingApi;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(overview), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    api = new HttpTicketingApi(new HttpTransport());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the brand’s retention overview', async () => {
    const result = await api.retention(BRAND);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/brands/${BRAND}/retention`);
    expect(result.preview.spamTickets).toBe(3);
  });

  it('puts the whole form', async () => {
    await api.updateRetention(BRAND, FORM);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(FORM);
  });
});

describe('MockTicketingApi retention', () => {
  it('starts where the artboard does', async () => {
    const result = await new MockTicketingApi().retention(BRAND);

    expect(result.settings.closedTickets).toEqual({ kind: 'days', days: 730 });
    expect(result.lastRun?.total).toBe(74);
  });

  it('keeps what was saved, and counts nothing for closed tickets kept forever', async () => {
    const api = new MockTicketingApi();

    const saved = await api.updateRetention(BRAND, FORM);

    expect(saved.settings).toEqual(FORM);
    expect(saved.preview.closedTickets).toBeNull();
    expect((await api.retention(BRAND)).settings.spamTicketDays).toBe(14);
  });
});
