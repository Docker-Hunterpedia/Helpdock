import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { TicketingError } from '../../../ticketing/api.js';
import { MockTicketsApi } from '../../../tickets/mock-api.js';

/**
 * The Views tab against the fixture, whose signed-in user is an Admin. What is
 * asserted is what the tab decides: which views it lists, what a built-in view
 * may change, which control leads to which call, and which refusal becomes
 * which sentence.
 */

const renderViews = async (tickets = new MockTicketsApi()) => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    ticketsApi: tickets,
    initialEntries: ['/admin/ticketing/views'],
  });

  await screen.findByRole('button', { name: 'Edit VIP refunds' });

  return { ...rendered, tickets };
};

const table = (): HTMLElement => screen.getByRole('table', { name: /^Shared views of/ });

const rowFor = (name: string): HTMLElement => {
  const row = within(table())
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByRole('button', { name: `Edit ${name}` }));
  if (row === undefined) {
    throw new Error(`no row for the view ${name}`);
  }

  return row;
};

const namesInOrder = (): string[] =>
  within(table())
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.querySelector('button')?.textContent ?? '');

describe('the list', () => {
  it('lists the shared views in sidebar order, and no personal one', async () => {
    await renderViews();

    expect(namesInOrder()).toEqual([
      'My open',
      'Unassigned',
      'Overdue',
      'All open · Support',
      'All open · Billing',
      'All open · Onboarding',
      'Escalated',
      'VIP refunds',
    ]);
    expect(screen.queryByRole('button', { name: 'Edit Urgent, mine' })).not.toBeInTheDocument();
  });

  it('says what each view shows, who sees it and how many tickets it holds', async () => {
    await renderViews();
    const row = rowFor('My open');

    expect(row).toHaveTextContent('built-in');
    expect(row).toHaveTextContent('Status is live · Assignee is me');
    expect(row).toHaveTextContent('Everyone');
    expect(await within(row).findByText('2')).toBeVisible();
    expect(rowFor('VIP refunds')).toHaveTextContent('Billing');
  });
});

describe('editing', () => {
  it('renames a built-in view but keeps its filters and audience fixed', async () => {
    const { user } = await renderViews();
    await user.click(screen.getByRole('button', { name: 'Edit Overdue' }));
    const card = await screen.findByRole('form', { name: 'Edit view · Overdue' });

    expect(within(card).getByLabelText('Status')).toBeDisabled();
    expect(within(card).getByRole('radio', { name: 'Everyone in the brand' })).toBeDisabled();
    expect(within(card).queryByRole('button', { name: 'Delete view' })).not.toBeInTheDocument();

    await user.clear(within(card).getByLabelText('Name'));
    await user.type(within(card).getByLabelText('Name'), 'Late');
    await user.click(within(card).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Late saved')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Edit Late' })).toBeVisible();
  });

  it('changes what a custom view shows', async () => {
    const { user, tickets } = await renderViews();
    const update = vi.spyOn(tickets, 'updateView');
    await user.click(screen.getByRole('button', { name: 'Edit VIP refunds' }));
    const card = await screen.findByRole('form', { name: 'Edit view · VIP refunds' });

    await user.selectOptions(within(card).getByLabelText('Assignee'), 'Nobody');
    await user.click(within(card).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalled();
    });
    expect(update.mock.calls[0]?.[2]).toMatchObject({
      filters: { assigneeId: ['unassigned'], priority: ['urgent'] },
    });
    expect(await within(rowFor('VIP refunds')).findByText(/Assignee is nobody/)).toBeVisible();
  });

  it('adds a view shared with a department once one is chosen', async () => {
    const { user } = await renderViews();
    await user.click(screen.getByRole('button', { name: 'Add view' }));
    const card = await screen.findByRole('form', { name: 'New view' });

    await user.type(within(card).getByLabelText('Name'), 'Billing backlog');
    await user.click(within(card).getByRole('radio', { name: 'Departments' }));
    expect(within(card).getByRole('button', { name: 'Add view' })).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Billing' }));
    await user.click(within(card).getByRole('button', { name: 'Add view' }));

    expect(await screen.findByText('Billing backlog added')).toBeVisible();
    expect(rowFor('Billing backlog')).toHaveTextContent('Billing');
  });

  it('turns a refusal into its sentence', async () => {
    const { user, tickets } = await renderViews();
    vi.spyOn(tickets, 'updateView').mockRejectedValue(new TicketingError('view-is-built-in'));
    await user.click(screen.getByRole('button', { name: 'Edit My open' }));
    await user.click(
      within(await screen.findByRole('form', { name: 'Edit view · My open' })).getByRole('button', {
        name: 'Save',
      }),
    );

    expect(
      await screen.findByText(
        'A built-in view can be renamed or hidden, not refiltered or deleted.',
      ),
    ).toBeVisible();
  });
});

describe('the row menu', () => {
  it('hides a view from the sidebar and shows it again', async () => {
    const { user } = await renderViews();

    await user.click(within(table()).getByRole('button', { name: 'Actions for Escalated' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide from the sidebar' }));

    expect(await screen.findByText('Escalated hidden from the sidebar')).toBeVisible();
    await waitFor(() => {
      expect(rowFor('Escalated')).toHaveTextContent('hidden');
    });

    await user.click(within(table()).getByRole('button', { name: 'Actions for Escalated' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Show in the sidebar' }));

    await waitFor(() => {
      expect(rowFor('Escalated')).not.toHaveTextContent('hidden');
    });
  });

  it('moves a view down and keeps the new order', async () => {
    const { user } = await renderViews();

    await user.click(within(table()).getByRole('button', { name: 'Actions for Escalated' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));

    await waitFor(() => {
      expect(namesInOrder().slice(-2)).toEqual(['VIP refunds', 'Escalated']);
    });
  });

  it('offers no Delete for a built-in view', async () => {
    const { user } = await renderViews();

    await user.click(within(table()).getByRole('button', { name: 'Actions for Unassigned' }));

    expect(await screen.findByRole('menuitem', { name: 'Move up' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('deletes a custom view after asking', async () => {
    const { user } = await renderViews();

    await user.click(within(table()).getByRole('button', { name: 'Actions for VIP refunds' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete view' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Edit VIP refunds' })).not.toBeInTheDocument();
    });
  });
});
