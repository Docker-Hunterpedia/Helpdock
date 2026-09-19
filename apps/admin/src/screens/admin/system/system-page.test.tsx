import type { SystemStatus } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.tsx';
import {
  ALL_QUEUE_NAMES,
  degradedSystemStatus,
  fakeSystemApi,
  healthySystemStatus,
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

  it('offers the queue screen under its visible label, with the tooltip as a description', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    const link = await screen.findByRole('link', { name: 'Open queue dashboard' });

    expect(link).toHaveAttribute('href', '/admin/system/queues');
    // A tooltip must describe the control, not rename it (WCAG 2.5.3).
    expect(link).toHaveAccessibleDescription(
      'Opens the full queue table. The embedded Bull Board arrives with milestone M8.',
    );
  });

  it('says a subsystem is not configured rather than showing it as zero', async () => {
    renderSystem(apiReturning(healthySystemStatus()));

    const usage = await screen.findByRole('region', { name: /Storage and AI spend/ });

    expect(within(usage).getAllByText('Not configured')).toHaveLength(2);
    expect(
      within(usage).getByText('Attachment storage is measured from milestone M1.'),
    ).toBeVisible();
    expect(within(usage).queryByText('0 B')).not.toBeInTheDocument();
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
