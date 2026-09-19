import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../../test/render.tsx';
import { ALL_QUEUE_NAMES, fakeSystemApi } from './fixtures.js';
import { NotAllowedError, type SystemApi, SystemApiError } from './system-api.js';
import { SystemQueuesPage } from './system-queues-page.tsx';

const apiReturning = (): SystemApi => fakeSystemApi();

const apiThrowing = (error: Error): SystemApi =>
  fakeSystemApi({
    status: async () => {
      throw error;
    },
  });

describe('SystemQueuesPage', () => {
  it('shows every queue, not just the summary, and says why it is not Bull Board yet', async () => {
    renderApp(<SystemQueuesPage api={apiReturning()} />);

    const table = await screen.findByRole('table', { name: 'Queues' });
    await expect
      .poll(() => within(table).getAllByRole('row').length)
      .toBe(ALL_QUEUE_NAMES.length + 1);
    // The screen opens expanded, so there is nothing to unfold.
    expect(screen.queryByRole('button', { name: 'All queues' })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Opens the full queue table. The embedded Bull Board arrives with milestone M8.',
      ),
    ).toBeVisible();
  });

  it('offers the way back to the System page', async () => {
    renderApp(<SystemQueuesPage api={apiReturning()} />);

    expect(await screen.findByRole('link', { name: 'Back' })).toHaveAttribute(
      'href',
      '/admin/system',
    );
  });

  it('draws a refusal as "Not allowed"', async () => {
    renderApp(<SystemQueuesPage api={apiThrowing(new NotAllowedError())} />);

    expect(await screen.findByRole('heading', { name: 'Not allowed' })).toBeInTheDocument();
  });

  it('draws any other failure as a read that did not answer', async () => {
    renderApp(<SystemQueuesPage api={apiThrowing(new SystemApiError('the api answered 500'))} />);

    expect(
      await screen.findByRole('heading', { name: 'Could not read the system status' }),
    ).toBeInTheDocument();
  });
});
