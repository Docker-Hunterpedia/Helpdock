import type { ReportQuery } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { AuthError } from '../../auth/api.js';
import type { ReportsApi } from '../../reports/api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { fakeReportsApi, OMAR, reportSummary } from './fixtures.js';
import { isoDay } from './report-range.js';

const renderReports = async (reportsApi: ReportsApi = fakeReportsApi()) => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    reportsApi,
    initialEntries: ['/reports'],
  });
  // The first render pulls in the whole app; on a busy machine it takes more than a second.
  await screen.findByRole('heading', { name: 'Reports', level: 1 }, { timeout: 10_000 });

  return rendered;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ReportsPage (M8-04)', () => {
  it('asks for the last 30 days, then the 30 before them to compare with', async () => {
    const summary = vi.fn(fakeReportsApi().summary);
    await renderReports(fakeReportsApi({ summary }));

    await screen.findByRole('region', { name: 'Ticket volume' });
    await waitFor(() => {
      expect(summary).toHaveBeenCalledTimes(2);
    });
    const [current, previous] = summary.mock.calls.map(([, query]) => query);
    expect(current?.to).toBe(isoDay(new Date()));
    expect(previous?.to).toBe(
      new Date(Date.parse(current?.from ?? '') - 86_400_000).toISOString().slice(0, 10),
    );
  });

  it('compares the KPI tiles with the previous period in words', async () => {
    await renderReports();

    const created = await screen.findByRole('region', { name: 'Tickets created' });
    expect(within(created).getByText('1,020')).toBeVisible();
    expect(await within(created).findByText('8 % more than the previous 30 days')).toBeVisible();
    const response = screen.getByRole('region', { name: 'Median first response' });
    expect(within(response).getByText('42m')).toBeVisible();
    expect(within(response).getByText('6m faster than the previous 30 days')).toBeVisible();
    const sla = screen.getByRole('region', { name: 'SLA met' });
    expect(within(sla).getByText('93.4 %')).toBeVisible();
    expect(within(sla).getByText(/points lower than the previous 30 days$/)).toBeVisible();
    const csat = screen.getByRole('region', { name: 'CSAT' });
    expect(within(csat).getByText('4.5 / 5')).toBeVisible();
    expect(within(csat).getByText('212 answers · unchanged')).toBeVisible();
  });

  it('draws every card of the artboard, the AI ones as not available until M7', async () => {
    await renderReports();

    for (const title of [
      'Ticket volume',
      'First response and resolution time',
      'SLA compliance',
      'Backlog trend',
      'Customer satisfaction',
      'Agent workload',
      'Busiest hours',
      'Help center top searches',
      'Searches with no results',
    ]) {
      expect(await screen.findByRole('region', { name: title })).toBeInTheDocument();
    }
    for (const title of ['AI deflection rate', 'AI cost']) {
      const card = screen.getByRole('region', { name: title });
      expect(
        within(card).getByText('Not available until the AI assistant records its calls (M7).'),
      ).toBeVisible();
      expect(within(card).queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();
    }
  });

  it('states every chart in words for a screen reader', async () => {
    await renderReports();

    const volume = await screen.findByRole('region', { name: 'Ticket volume' });
    expect(
      within(volume).getByRole('img', {
        name: 'Tickets created per day: 1020 created and 900 resolved over 30 days. By Channel: Email 450, Chat 360, Telegram 201.',
      }),
    ).toBeInTheDocument();
    const hours = screen.getByRole('region', { name: 'Busiest hours' });
    expect(
      within(hours).getByRole('img', { name: /^Busiest hour Mon 10:00–11:00 with 26/ }),
    ).toBeInTheDocument();
  });

  it('swaps a chart for its table and back', async () => {
    const { user } = await renderReports();
    const backlog = await screen.findByRole('region', { name: 'Backlog trend' });
    const toggle = within(backlog).getByRole('button', { name: 'Table · Backlog trend' });

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const table = within(backlog).getByRole('table', { name: 'Backlog trend' });
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    expect(within(backlog).queryByRole('img')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(within(backlog).getByRole('img')).toBeInTheDocument();
  });

  it('stacks the volume by priority and by status, with a legend and a column per series', async () => {
    const { user } = await renderReports();
    const volume = await screen.findByRole('region', { name: 'Ticket volume' });

    await user.click(within(volume).getByRole('button', { name: 'Priority' }));

    expect(
      within(volume).getByRole('img', {
        name: 'Tickets created by Priority: Medium 921, Urgent 90.',
      }),
    ).toBeInTheDocument();
    const legend = within(volume).getByRole('list');
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Medium', 'Urgent']);

    await user.click(within(volume).getByRole('button', { name: 'Status' }));
    await user.click(within(volume).getByRole('button', { name: 'Table · Ticket volume' }));

    const table = within(volume).getByRole('table', { name: 'Ticket volume' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Day', 'Closed', 'Open', 'Created', 'Resolved']);
  });

  it('exports the volume by status when the status breakdown is shown', async () => {
    const exportCsv = vi.fn(fakeReportsApi().exportCsv);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:report'), revokeObjectURL: vi.fn() }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { user } = await renderReports(fakeReportsApi({ exportCsv }));
    const volume = await screen.findByRole('region', { name: 'Ticket volume' });

    await user.click(within(volume).getByRole('button', { name: 'Status' }));
    await user.click(within(volume).getByRole('button', { name: 'Export CSV · Ticket volume' }));

    await waitFor(() => {
      expect(exportCsv.mock.calls[0]?.[1]).toBe('volume_by_status');
    });
  });

  it('shows SLA compliance by priority as well as by clock', async () => {
    await renderReports();
    const sla = await screen.findByRole('region', { name: 'SLA compliance' });

    expect(within(sla).getByRole('heading', { name: 'By priority' })).toBeVisible();
    expect(
      within(sla).getByRole('img', {
        name: 'SLA met by priority: Urgent 86.2 % of 94, Medium 94.6 % of 598.',
      }),
    ).toBeInTheDocument();
  });

  it("lists each agent's times, SLA and CSAT, and the open tickets nobody has", async () => {
    await renderReports();
    const agents = await screen.findByRole('region', { name: 'Agent workload' });
    const rows = within(agents).getAllByRole('row');

    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual([
      'Agent',
      'Open assigned',
      'Solved',
      'Replies',
      'First response',
      'Resolution',
      'SLA met',
      'CSAT',
    ]);
    expect(
      within(rows[1] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Lina Haddad', '18', '214', '486', '31m', '7h 20m', '95.1 %', '4.7']);
    // An agent with nothing measured reads as a dash, not a zero.
    expect(
      within(rows[2] as HTMLElement)
        .getAllByRole('cell')
        .at(4),
    ).toHaveTextContent('—');
    expect(
      within(rows[3] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Unassigned', '57', '—', '—', '—', '—', '—', '—']);
  });

  it("asks for one agent's report, and leaves the Unassigned row out of it", async () => {
    const summary = vi.fn(async (brandId: string, query: ReportQuery) =>
      query.agentId === undefined
        ? fakeReportsApi().summary(brandId, query)
        : reportSummary(query, {
            filters: { departmentId: null, channel: null, agentId: query.agentId },
          }),
    );
    const { user } = await renderReports(fakeReportsApi({ summary }));
    await screen.findByRole('region', { name: 'Agent workload' });

    await user.click(screen.getByRole('combobox', { name: 'Agent' }));
    await user.click(await screen.findByRole('option', { name: 'Omar' }));

    await waitFor(() => {
      expect(summary).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ agentId: OMAR }),
      );
    });
    const agents = screen.getByRole('region', { name: 'Agent workload' });
    await waitFor(() => {
      expect(within(agents).queryByRole('cell', { name: 'Unassigned' })).not.toBeInTheDocument();
    });
  });

  it('exports a card as CSV with the filters in force', async () => {
    const exportCsv = vi.fn(fakeReportsApi().exportCsv);
    const createObjectURL = vi.fn(() => 'blob:report');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { user } = await renderReports(fakeReportsApi({ exportCsv }));
    const sla = await screen.findByRole('region', { name: 'SLA compliance' });

    await user.click(within(sla).getByRole('button', { name: 'Export CSV · SLA compliance' }));

    await waitFor(() => {
      expect(click).toHaveBeenCalled();
    });
    const [, report, query] = exportCsv.mock.calls[0] ?? [];
    expect(report).toBe('sla');
    expect(query).toMatchObject({ to: isoDay(new Date()) });
    expect(query).not.toHaveProperty('channel');
  });

  it('says so when an export fails', async () => {
    const { user } = await renderReports(
      fakeReportsApi({
        exportCsv: async () => {
          throw new AuthError('unavailable');
        },
      }),
    );
    const csat = await screen.findByRole('region', { name: 'Customer satisfaction' });

    await user.click(
      within(csat).getByRole('button', { name: 'Export CSV · Customer satisfaction' }),
    );

    expect(await screen.findByText('The CSV could not be downloaded. Try again.')).toBeVisible();
  });

  it('asks again for one channel when the filter changes', async () => {
    const summary = vi.fn(fakeReportsApi().summary);
    const { user } = await renderReports(fakeReportsApi({ summary }));
    await screen.findByRole('region', { name: 'Ticket volume' });

    await user.click(screen.getByRole('combobox', { name: 'Channel' }));
    await user.click(await screen.findByRole('option', { name: 'Telegram' }));

    await waitFor(() => {
      expect(summary).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ channel: 'telegram' }),
      );
    });
  });

  it('draws a failed read as an error, not as empty reports', async () => {
    await renderReports(
      fakeReportsApi({
        summary: async () => {
          throw new AuthError('unavailable');
        },
      }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Could not read the reports' }),
    ).toBeInTheDocument();
  });

  it('draws the AI cards from the summary once M7 records them', async () => {
    await renderReports(
      fakeReportsApi({
        summary: async (_brand, query) =>
          reportSummary(query, {
            ai: {
              available: true,
              deflection: { eligible: 648, deflected: 205, rate: 205 / 648 },
              cost: { calls: 1200, tokensIn: 3_000_000, tokensOut: 400_000, costUsd: 48.2 },
            },
          }),
      }),
    );

    const deflection = await screen.findByRole('region', { name: 'AI deflection rate' });
    expect(within(deflection).getByText('31.6 %')).toBeVisible();
    expect(within(deflection).getByText('205 of 648 eligible conversations')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'AI cost' })).getByText('$48.20'),
    ).toBeVisible();
  });
});
