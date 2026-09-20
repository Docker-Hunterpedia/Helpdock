import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import type { MockTicketingApi } from '../../../ticketing/mock-api.js';

/**
 * The Statuses tab against the fixture (M1-08).
 *
 * What is worth asserting is what the screen decides — which control leads to
 * which call, which confirmation is asked for and with what number in it, which
 * refusal becomes which sentence — rather than the markup it decides it with.
 */

const renderStatuses = async (ticketingApi?: MockTicketingApi) => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketingApi ?? ticketing,
    initialEntries: ['/admin/ticketing/statuses'],
  });

  // The table element appears before its rows do; waiting for a row means a
  // query for the list is never racing the fixture.
  await screen.findByRole('button', { name: 'Edit Open' });

  return rendered;
};

/** The name cell of each row, in order, addressed as a cell rather than a button. */
const namesInOrder = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '');

describe('the list', () => {
  it('shows the brand’s statuses with their system state', async () => {
    await renderStatuses();

    expect(await screen.findByRole('button', { name: 'Edit Awaiting customer' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit Waiting on supplier' })).toBeVisible();
    // Four system states, and "On hold" is what `on_hold` reads as.
    expect(screen.getAllByText('On hold').length).toBeGreaterThan(0);
  });

  it('marks the default, the seeded rows and the brand’s own', async () => {
    await renderStatuses();

    const open = screen.getAllByRole('row')[1];
    expect(within(open as HTMLElement).getByText('default')).toBeVisible();

    const custom = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Waiting on supplier'));
    expect(within(custom as HTMLElement).getByText('custom')).toBeVisible();
  });

  it('shows the Arabic name under the Latin one', async () => {
    await renderStatuses();

    expect(await screen.findByText('بانتظار العميل')).toBeInTheDocument();
  });

  it('says nothing is selected until something is', async () => {
    await renderStatuses();

    expect(await screen.findByText(/Choose a status to edit/)).toBeInTheDocument();
  });
});

describe('the editor', () => {
  it('creates a status from the side card', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    await user.click(screen.getByRole('button', { name: 'Add status' }));
    await user.type(screen.getByLabelText('Name'), 'Waiting on legal');
    await user.click(screen.getByRole('button', { name: 'Create status' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Waiting on legal added');
    expect(
      await screen.findByRole('button', { name: 'Edit Waiting on legal' }),
    ).toBeInTheDocument();
  });

  it('refuses a name another status already has', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    await user.click(screen.getByRole('button', { name: 'Add status' }));
    await user.type(screen.getByLabelText('Name'), 'Closed');
    await user.click(screen.getByRole('button', { name: 'Create status' }));

    expect(await screen.findByRole('status')).toHaveTextContent('That name is already taken.');
  });

  it('renames a status and keeps it in the list', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    await user.click(screen.getByRole('button', { name: 'Edit Waiting on supplier' }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Waiting on vendor');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Waiting on vendor saved');
  });

  /**
   * A seeded status's state and flags are what the code finds it by
   * (`packages/db/src/ticket-statuses.ts`), so the controls are disabled rather
   * than hidden and the card says why.
   */
  it('locks the state and the flags of a seeded status, and says why', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    await user.click(screen.getByRole('button', { name: 'Edit Awaiting customer' }));

    expect(await screen.findByText(/A seeded status can be renamed and recoloured/)).toBeVisible();
    expect(screen.getByLabelText('Pauses SLA clocks')).toBeDisabled();
    expect(screen.getByLabelText('Counts as awaiting customer')).toBeDisabled();
  });

  it('offers no delete link for a seeded status', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    await user.click(screen.getByRole('button', { name: 'Edit Closed' }));
    await screen.findByDisplayValue('Closed');

    expect(screen.queryByRole('button', { name: /^Delete ·/ })).not.toBeInTheDocument();
  });
});

describe('deleting a status', () => {
  /**
   * The count comes from the server before anybody is asked, because "12
   * tickets move to Open" is a promise about other people's work.
   */
  it('says how many tickets would move, and where', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    await user.click(screen.getByRole('button', { name: 'Edit Waiting on supplier' }));

    expect(
      await screen.findByRole('button', { name: 'Delete · 12 tickets move to Open' }),
    ).toBeVisible();
  });

  it('asks before deleting, repeating the count', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    await user.click(screen.getByRole('button', { name: 'Edit Waiting on supplier' }));
    await user.click(
      await screen.findByRole('button', { name: 'Delete · 12 tickets move to Open' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete Waiting on supplier?');
    expect(dialog).toHaveTextContent('12 tickets move to Open');

    await user.click(within(dialog).getByRole('button', { name: 'Delete status' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Waiting on supplier deleted');
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Edit Waiting on supplier' }),
      ).not.toBeInTheDocument();
    });
  });
});

describe('reordering', () => {
  it('moves a status from the keyboard alone', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    expect(namesInOrder()[0]).toContain('Open');

    // The drag handle is a real button, so the keyboard alternative is on the
    // control itself as well as in the row menu (DESIGN §10).
    screen.getByRole('button', { name: 'Reorder Open' }).focus();
    await user.keyboard('{ArrowDown}');

    expect(await screen.findByRole('status')).toHaveTextContent('New order saved');
    await waitFor(() => {
      expect(namesInOrder()[0]).toContain('Awaiting customer');
    });
  });
});

describe('the reply behaviour card', () => {
  it('saves the toggle and the reopen window together', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    const card = await screen.findByRole('form', { name: 'Reply behaviour' });
    await user.click(
      within(card).getByLabelText('Move to Awaiting customer when an agent sends a public reply'),
    );
    const days = within(card).getByLabelText('Days the ticket stays reopenable');
    await user.clear(days);
    await user.type(days, '14');
    await user.click(within(card).getByRole('button', { name: 'Save reply behaviour' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Reply behaviour saved');
  });

  /**
   * A day count beside "Always reopen" is a control that does nothing, and a
   * control that does nothing is one somebody will set and then be surprised by.
   */
  it('hides the day count for a policy that has no window', async () => {
    const user = userEvent.setup();
    await renderStatuses();

    const card = await screen.findByRole('form', { name: 'Reply behaviour' });
    await user.click(within(card).getByLabelText('When a customer replies to a closed ticket'));
    await user.click(await screen.findByRole('option', { name: 'Always reopen' }));

    await waitFor(() => {
      expect(
        within(card).queryByLabelText('Days the ticket stays reopenable'),
      ).not.toBeInTheDocument();
    });
  });
});
