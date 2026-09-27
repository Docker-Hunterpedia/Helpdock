import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpTicketingApi } from './http-api.js';

/**
 * M3-01 and M3-02's half of the adapter, against a stubbed `fetch`: which
 * route each call reaches and what it parses. That the routes behave is the
 * api's integration suite.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const POLICY = '0192c3f0-1a2b-7c3d-8e4f-0000000005a1';
const HOLIDAY = '0192c3f0-1a2b-7c3d-8e4f-0000000006a1';
const day = () => [{ start: '09:00', end: '17:00' }];
const hours = { timezone: 'Asia/Riyadh', weekly: [day(), day(), day(), day(), day(), [], []] };
const target = { firstResponseMinutes: 120, resolutionMinutes: 480 };
const policyBody = {
  name: 'Support',
  conditions: [],
  timeMode: 'business' as const,
  targets: { low: target, medium: target, high: target, urgent: target },
  escalation: [],
};
const policy = {
  ...policyBody,
  id: POLICY,
  position: 0,
  runningTickets: 0,
  updatedAt: '2026-09-27T10:00:00.000Z',
  updatedBy: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpTicketingApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpTicketingApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sent = (): { url: string; method: string | undefined; body: unknown } => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
};

describe('business hours', () => {
  const overview = { brand: hours, departments: [], holidays: [], runningTickets: 3 };

  it('reads and saves the whole tab', async () => {
    fetchMock.mockResolvedValueOnce(json(overview));
    expect(await api.businessHours(BRAND)).toEqual(overview);
    expect(sent()).toMatchObject({ url: `/api/brands/${BRAND}/business-hours`, method: 'GET' });

    fetchMock.mockResolvedValueOnce(json(overview));
    await api.updateBusinessHours(BRAND, { brand: hours, departments: [] });
    expect(sent()).toMatchObject({ method: 'PUT', body: { brand: hours, departments: [] } });
  });

  it('adds and deletes a holiday', async () => {
    const holiday = {
      id: HOLIDAY,
      name: 'Founding Day',
      startsOn: '2027-02-22',
      endsOn: '2027-02-22',
      departmentId: null,
    };
    fetchMock.mockResolvedValueOnce(json(holiday, 201));
    expect(
      await api.createHoliday(BRAND, { name: 'Founding Day', startsOn: '2027-02-22' }),
    ).toEqual(holiday);
    expect(sent()).toMatchObject({ url: `/api/brands/${BRAND}/holidays`, method: 'POST' });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteHoliday(BRAND, HOLIDAY);
    expect(sent()).toMatchObject({
      url: `/api/brands/${BRAND}/holidays/${HOLIDAY}`,
      method: 'DELETE',
    });
  });
});

describe('SLA policies', () => {
  it('lists, creates, saves, reorders and deletes', async () => {
    fetchMock.mockResolvedValueOnce(json({ policies: [policy] }));
    expect((await api.slaPolicies(BRAND)).policies).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(json(policy, 201));
    await api.createSlaPolicy(BRAND, policyBody);
    expect(sent()).toMatchObject({ url: `/api/brands/${BRAND}/sla-policies`, method: 'POST' });

    fetchMock.mockResolvedValueOnce(json(policy));
    await api.updateSlaPolicy(BRAND, POLICY, policyBody);
    expect(sent()).toMatchObject({
      url: `/api/brands/${BRAND}/sla-policies/${POLICY}`,
      method: 'PUT',
    });

    fetchMock.mockResolvedValueOnce(json({ policies: [policy] }));
    await api.reorderSlaPolicies(BRAND, [POLICY]);
    expect(sent()).toMatchObject({ method: 'POST', body: { policyIds: [POLICY] } });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteSlaPolicy(BRAND, POLICY);
    expect(sent()).toMatchObject({ method: 'DELETE' });
  });

  it('patches the settings for every policy', async () => {
    fetchMock.mockResolvedValueOnce(json({ aiCountsAsFirstResponse: false }));
    const settings = await api.updateSlaSettings(BRAND, { aiCountsAsFirstResponse: false });

    expect(settings.aiCountsAsFirstResponse).toBe(false);
    expect(sent()).toMatchObject({
      url: `/api/brands/${BRAND}/ticketing/sla-settings`,
      method: 'PATCH',
    });
  });
});
