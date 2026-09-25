import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MockTicketsApi } from '../../tickets/mock-api.js';
import { MOCK_VIEW_MINE, MOCK_VIEW_MY_OPEN } from '../../tickets/mock-views.js';

/**
 * Saved views in the workspace (M1-05, `Admin/View-Dialogs` panels 1–4): the
 * sidebar group, its ⋯ menu, "Save as a view", and the "Filters changed" bar.
 * What is asserted is what the screen decides — which bar it raises, which
 * actions it offers, where it goes after a save — against the fixture, whose
 * signed-in user is an Admin.
 */

const wideViewport = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
};

const renderTickets = async (entry = '/tickets', ticketsApi?: MockTicketsApi) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: ticketsApi ?? apis.tickets,
    uploader: apis.uploader,
    initialEntries: [entry],
  });

  await screen.findByRole('region', { name: 'Ticket list' });

  return rendered;
};

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Main' });

/** Opens the filter popover, toggles one chip, and closes it again. */
const toggleFilter = async (
  user: Awaited<ReturnType<typeof renderTickets>>['user'],
  chip: string,
): Promise<void> => {
  await user.click(await screen.findByRole('button', { name: /^Filter/ }));
  await user.click(await screen.findByRole('switch', { name: chip }));
  await user.keyboard('{Escape}');
};

describe('saved views in the workspace', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists shared views, then the reader\'s own under "Mine"', async () => {
    await renderTickets();

    expect(await within(nav()).findByRole('link', { name: /^VIP refunds/ })).toBeVisible();
    expect(within(nav()).getByText('Mine')).toBeVisible();
    expect(within(nav()).getByRole('link', { name: /^Urgent, mine/ })).toBeVisible();
    expect(within(nav()).getByRole('link', { name: /^My open/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('prints a count past the cap as 999+', async () => {
    const tickets = new MockTicketsApi();
    vi.spyOn(tickets, 'viewCounts').mockResolvedValue({
      counts: [{ viewId: MOCK_VIEW_MY_OPEN, count: 999, capped: true }],
    });
    await renderTickets('/tickets', tickets);

    expect(await within(nav()).findByRole('link', { name: 'My open 999+' })).toBeVisible();
  });

  it('raises "Filters changed" when a filter moves off the view, and Reset puts it back', async () => {
    const { user } = await renderTickets(`/tickets?view=${MOCK_VIEW_MINE}`);
    await screen.findByRole('heading', { name: 'Urgent, mine', level: 1 });

    await toggleFilter(user, 'High');

    const bar = await screen.findByRole('status');
    expect(bar).toHaveTextContent('Filters changed');
    expect(within(bar).getByRole('button', { name: 'Save' })).toBeVisible();

    await user.click(within(bar).getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(screen.queryByText('Filters changed')).not.toBeInTheDocument();
    });
  });

  it('offers Save as new but never Save on a built-in view', async () => {
    const { user } = await renderTickets();
    await screen.findByRole('heading', { name: 'My open', level: 1 });

    await toggleFilter(user, 'Urgent');

    const bar = await screen.findByRole('status');
    expect(within(bar).getByRole('button', { name: 'Save as new' })).toBeVisible();
    expect(within(bar).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('removes one filter from its chip', async () => {
    const { user } = await renderTickets(`/tickets?view=${MOCK_VIEW_MINE}`);

    await user.click(await screen.findByRole('button', { name: 'Remove Priority: Urgent' }));

    expect(await screen.findByText('Filters changed')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Remove Priority: Urgent' }),
    ).not.toBeInTheDocument();
  });

  it('overwrites an editable view with Save', async () => {
    const { user } = await renderTickets(`/tickets?view=${MOCK_VIEW_MINE}`);
    await toggleFilter(user, 'High');

    await user.click(
      within(await screen.findByRole('status')).getByRole('button', { name: 'Save' }),
    );

    expect(await screen.findByText('Urgent, mine updated')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText('Filters changed')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Remove Priority: High' })).toBeVisible();
  });

  it('saves the filters as a new personal view and opens it', async () => {
    const { user } = await renderTickets();
    await toggleFilter(user, 'Urgent');

    await user.click(await screen.findByRole('button', { name: 'Save as new' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as a view' });
    expect(dialog).toHaveTextContent('Priority is Urgent');
    await user.type(within(dialog).getByLabelText('Name'), 'Urgent and open');
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));

    expect(await screen.findByRole('heading', { name: 'Urgent and open', level: 1 })).toBeVisible();
    expect(within(nav()).getByRole('link', { name: /^Urgent and open/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.queryByText('Filters changed')).not.toBeInTheDocument();
  });

  it('asks for departments before sharing a new view with them', async () => {
    const { user } = await renderTickets('/tickets?intent=save');
    const dialog = await screen.findByRole('dialog', { name: 'Save as a view' });

    await user.type(within(dialog).getByLabelText('Name'), 'Shared queue');
    await user.click(within(dialog).getByRole('radio', { name: /Shared with departments/ }));

    expect(within(dialog).getByRole('button', { name: 'Save view' })).toBeDisabled();
    await user.click(await within(dialog).findByRole('button', { name: 'Billing' }));
    expect(within(dialog).getByRole('button', { name: 'Save view' })).toBeEnabled();
  });

  it('opens the filters when the sidebar asks to edit them', async () => {
    const { user } = await renderTickets();

    await user.click(
      await within(nav()).findByRole('button', { name: 'Actions for Urgent, mine' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Edit filters' }));

    expect(await screen.findByRole('switch', { name: 'Urgent' })).toBeChecked();
  });

  it('renames and then deletes a personal view from its menu', async () => {
    const { user } = await renderTickets();

    await user.click(
      await within(nav()).findByRole('button', { name: 'Actions for Urgent, mine' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename Urgent, mine' });
    await user.clear(within(rename).getByLabelText('Name'));
    await user.type(within(rename).getByLabelText('Name'), 'Hot, mine');
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(await within(nav()).findByRole('link', { name: /^Hot, mine/ })).toBeVisible();

    await user.click(within(nav()).getByRole('button', { name: 'Actions for Hot, mine' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete view' }));

    await waitFor(() => {
      expect(within(nav()).queryByRole('link', { name: /^Hot, mine/ })).not.toBeInTheDocument();
    });
  });

  it('offers a built-in view nothing but Rename', async () => {
    const { user } = await renderTickets();

    await user.click(await within(nav()).findByRole('button', { name: 'Actions for Overdue' }));

    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename']);
  });

  it('shares a personal view with a department', async () => {
    const { user } = await renderTickets();

    await user.click(
      await within(nav()).findByRole('button', { name: 'Actions for Urgent, mine' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Share with…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Urgent, mine' });
    await user.click(await within(dialog).findByRole('button', { name: 'Support' }));
    await user.click(within(dialog).getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(within(nav()).queryByText('Mine')).not.toBeInTheDocument();
    });
    expect(within(nav()).getByRole('link', { name: /^Urgent, mine/ })).toBeVisible();
  });
});
