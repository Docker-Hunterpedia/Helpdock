import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { reportSummary } from '../screens/reports/fixtures.js';
import { HttpReportsApi, reportSearch } from './api.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reportSearch', () => {
  it('sends only the filters that are set', () => {
    expect(reportSearch({ from: '2026-09-05', to: '2026-10-04' })).toBe(
      'from=2026-09-05&to=2026-10-04',
    );
    expect(
      reportSearch({
        from: '2026-09-05',
        to: '2026-10-04',
        departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000e1',
        channel: 'telegram',
      }),
    ).toBe(
      'from=2026-09-05&to=2026-10-04&departmentId=0192c3f0-1a2b-7c3d-8e4f-0000000000e1&channel=telegram',
    );
  });
});

describe('HttpReportsApi', () => {
  it('reads the summary with the access token and parses it', async () => {
    const summary = reportSummary();
    const fetch = vi.fn(async () => new Response(JSON.stringify(summary), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const transport = new HttpTransport();
    transport.accessToken = 'token';

    const read = await new HttpReportsApi(transport).summary(BRAND, {
      from: '2026-09-05',
      to: '2026-10-04',
    });

    expect(read).toEqual(summary);
    expect(fetch).toHaveBeenCalledWith(
      `/api/brands/${BRAND}/reports?from=2026-09-05&to=2026-10-04`,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer token' }),
      }),
    );
  });

  it('refuses a summary that does not match the schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ volume: {} }), { status: 200 })),
    );

    await expect(
      new HttpReportsApi().summary(BRAND, { from: '2026-09-05', to: '2026-10-04' }),
    ).rejects.toThrow();
  });

  it('downloads one report as CSV from the export route', async () => {
    const fetch = vi.fn(async () => new Response('day,created\r\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const blob = await new HttpReportsApi().exportCsv(BRAND, 'busiest_hours', {
      from: '2026-09-05',
      to: '2026-10-04',
      channel: 'email',
    });

    expect(await blob.text()).toBe('day,created\r\n');
    expect(fetch).toHaveBeenCalledWith(
      `/api/brands/${BRAND}/reports/exports/busiest_hours?from=2026-09-05&to=2026-10-04&channel=email`,
      expect.anything(),
    );
  });
});
