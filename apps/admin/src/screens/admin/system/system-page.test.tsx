import type { SystemStatus } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.tsx';
import {
  ALL_QUEUE_NAMES,
  activeDeletion,
  degradedSystemStatus,
  fakeSystemApi,
  healthySystemStatus,
  measuredSystemStatus,
  OLD_STORE_BRAND,
  QUEUE_BOARD_PASS,
} from './fixtures.js';
import { NotAllowedError, type SystemApi, SystemApiError } from './system-api.js';
import { SystemPage } from './system-page.tsx';

const apiReturning = (status: SystemStatus): SystemApi =>
  fakeSystemApi({ status: async () => status });

const apiThrowing = (error: Error): SystemApi =>
  fakeSystemApi({
    status: async () => {
      throw error;
    },
  });

const renderSystem = (api: SystemApi) => renderApp(<SystemPage api={api} />);

describe('SystemPage', () => {
  it('announces that it is reading before anything has arrived', () => {
    renderSystem(fakeSystemApi({ status: () => new Promise(() => {}) }));

    expect(screen.getByRole('status')).toHaveTextContent('Reading the system status');
  });

  it('draws the four health cards of the artboard', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    expect(await screen.findByRole('region', { name: 'API' })).toBeInTheDocument();
    for (const card of ['Worker', 'Postgres', 'Redis']) {
      expect(screen.getByRole('region', { name: card })).toBeInTheDocument();
    }

    expect(
      within(screen.getByRole('region', { name: 'Postgres' })).getByText('17.6'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Postgres' })).getByText(
        '4 migrations applied · role helpdock_app · RLS forced',
      ),
    ).toBeVisible();
  });

  it('says how long ago it refreshed and which build is running', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    expect(await screen.findByText('Install-wide · refreshed just now')).toBeInTheDocument();
    expect(screen.getByText('helpdock 0.1.0 · a2cf2b3 · node v24.18.0')).toBeInTheDocument();
  });

  it('names the degraded state in words, not only in a hue', async () => {
    renderSystem(apiReturning(degradedSystemStatus()));

    const redis = await screen.findByRole('region', { name: 'Redis' });

    expect(within(redis).getByText('Degraded')).toBeVisible();
    expect(within(redis).getByText('AOF rewrite running · latency 38 ms')).toBeVisible();
  });

  it('warns that the worker is silent when no relay has reported', async () => {
    renderSystem(apiReturning(healthySystemStatus({ relay: { reporting: false } })));

    const worker = await screen.findByRole('region', { name: 'Worker' });

    expect(within(worker).getByText('Degraded')).toBeVisible();
    expect(within(worker).getByText('no relay has reported; is a worker running?')).toBeVisible();
  });

  it('shows the queues the status read carried, and the dead-letter count', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    const table = await screen.findByRole('table', { name: 'Queues' });
    // One header row plus the five the status read carries.
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(screen.getByText('Showing 5 of 11')).toBeInTheDocument();
    expect(screen.getByText('3 in dead letter')).toBeInTheDocument();
  });

  it('fetches the rest when asked, rather than relabelling the same five rows', async () => {
    const { user } = renderSystem(apiReturning(healthySystemStatus()));
    await screen.findByRole('table', { name: 'Queues' });

    await user.click(screen.getByRole('button', { name: 'All queues' }));

    const table = await screen.findByRole('table', { name: 'Queues' });
    await expect
      .poll(() => within(table).getAllByRole('row').length)
      .toBe(ALL_QUEUE_NAMES.length + 1);
    expect(screen.getByText(`Showing 11 of ${ALL_QUEUE_NAMES.length}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });

  it('opens Bull Board in a new tab with a one-use pass (M8-05)', async () => {
    const tab = { opener: {} as unknown, location: { assign: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const queueBoardPass = vi.fn(async () => QUEUE_BOARD_PASS);
    const { user } = renderSystem(fakeSystemApi({ queueBoardPass }));

    await user.click(await screen.findByRole('button', { name: 'Open queue dashboard' }));

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => {
      expect(tab.location.assign).toHaveBeenCalledWith(QUEUE_BOARD_PASS);
    });
    expect(tab.opener).toBeNull();
    open.mockRestore();
  });

  it('closes the blank tab and says so when the pass is refused', async () => {
    const tab = { opener: null, location: { assign: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { user } = renderSystem(
      fakeSystemApi({
        queueBoardPass: async () => {
          throw new SystemApiError('the api answered 403', 403);
        },
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Open queue dashboard' }));

    expect(
      await screen.findByText('Could not open the queue dashboard. Try again.'),
    ).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.assign).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('draws the product metrics in words (M8-07)', async () => {
    renderSystem(fakeSystemApi());

    const activation = await screen.findByRole('region', { name: 'Activation' });
    expect(within(activation).getByText('Day 2')).toBeVisible();
    expect(within(activation).getByText('Activated')).toBeVisible();
    const selfService = screen.getByRole('region', { name: 'Help center self-service' });
    expect(within(selfService).getByText('78.4 %')).toBeVisible();
    expect(within(selfService).getByText('9,412 views')).toBeVisible();
    const deflection = screen.getByRole('region', { name: 'AI deflection rate' });
    expect(
      within(deflection).getByText(
        'Not available until the AI assistant records auto-replies (M7).',
      ),
    ).toBeVisible();
  });

  it('says what is not measured or not set up rather than showing a zero', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    const storage = await screen.findByRole('region', { name: 'Storage' });
    expect(within(storage).getByText(/^Not measured yet/)).toBeVisible();
    expect(within(storage).queryByText('0 B')).not.toBeInTheDocument();
    const llm = screen.getByRole('region', { name: 'LLM spend by brand' });
    expect(
      within(llm).getByText('Not available until the AI assistant is set up (M7).'),
    ).toBeVisible();
  });

  it('measures storage per brand and marks the one pending deletion', async () => {
    renderSystem(apiReturning(measuredSystemStatus()));

    const storage = await screen.findByRole('region', { name: 'Storage' });
    expect(within(storage).getByRole('progressbar', { name: 'Storage 37 %' })).toBeVisible();
    expect(within(storage).getByText('37 % of the 50.0 GB soft limit')).toBeVisible();
    const table = within(storage).getByRole('table', { name: 'Storage by brand' });
    expect(within(table).getByText('· pending deletion')).toBeVisible();
    expect(within(table).getByText('11.2 GB')).toBeVisible();
    // Postgres is the whole database; the artboard's per-brand column is not drawn.
    expect(within(storage).getByText('3.2 GB')).toBeVisible();
    expect(within(storage).getByText('The whole database · not measured per brand')).toBeVisible();
  });

  it('lists the newest migrations under the count', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    const version = await screen.findByRole('region', { name: 'Version and migrations' });
    const recent = within(version).getByRole('list', { name: 'Newest migrations' });
    expect(
      within(recent)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '0003_outbox_notify_relay',
      '0002_tenant_rls_policies',
      '0001_app_role_and_ticket_sequences',
    ]);
  });

  it("draws each brand's LLM spend against its budget, and warns past the alert", async () => {
    renderSystem(apiReturning(measuredSystemStatus()));

    const llm = await screen.findByRole('region', { name: 'LLM spend by brand' });
    const rows = within(llm).getAllByRole('row');
    expect(rows.slice(1).map((row) => row.firstChild?.textContent)).toEqual([
      'Acme Store',
      'Helpdock',
      'Old Store',
      'Install',
    ]);
    expect(within(llm).getByText('86 % of $100.00 · past the 80 % alert')).toBeVisible();
    expect(within(llm).getByText('48 % of $100.00')).toBeVisible();
    expect(within(llm).getAllByText('No monthly budget')).toHaveLength(2);
  });

  it('lists the brands pending deletion with their countdown, and restores one', async () => {
    const restoreBrand = vi.fn(async (brandId: string) => activeDeletion(brandId));
    const { user } = renderSystem(fakeSystemApi({ restoreBrand }));

    const card = await screen.findByRole('region', { name: 'Brands pending deletion' });
    expect(await within(card).findByText('26 days left')).toBeVisible();
    expect(within(card).getByText('3 days left')).toBeVisible();
    expect(within(card).getByText('2 brands · 30-day grace')).toBeVisible();
    expect(within(card).getByText(/^Deleted by Lina Haddad on /)).toBeVisible();
    expect(within(card).getByText(/^Deleted by a removed account on /)).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Restore Old Store' }));

    expect(restoreBrand).toHaveBeenCalledWith(OLD_STORE_BRAND);
    expect(await screen.findByText('Old Store is restored.')).toBeInTheDocument();
  });

  it('says there are no channels yet, and which milestone brings them', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    expect(await screen.findByText('No channels yet · added in M2')).toBeInTheDocument();
  });

  it('draws a 403 as "Not allowed" rather than as a failure', async () => {
    renderSystem(apiThrowing(new NotAllowedError()));

    expect(await screen.findByRole('heading', { name: 'Not allowed' })).toBeInTheDocument();
    expect(
      screen.getByText('The System page is install-wide, so only an install admin can open it.'),
    ).toBeInTheDocument();
  });

  it('says the api did not answer when the read fails for any other reason', async () => {
    renderSystem(apiThrowing(new SystemApiError('the api answered 500')));

    expect(
      await screen.findByRole('heading', { name: 'Could not read the system status' }),
    ).toBeInTheDocument();
  });

  it('writes the queue numerals in Latin digits in Arabic, end-aligned', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderSystem(apiReturning(healthySystemStatus()));

    const table = await screen.findByRole('table', { name: 'الطوابير' });
    const waiting = within(table).getByText('2');

    expect(waiting).toBeVisible();
    // DESIGN §7: Latin digits in both locales, and §6.5: numerals end-aligned.
    expect(table.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/);
    expect(waiting.closest('td')).toHaveStyle({ textAlign: 'end' });
  });
});
