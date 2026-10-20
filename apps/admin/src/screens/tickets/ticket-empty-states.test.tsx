import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockAuthApi } from '../../auth/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import {
  MOCK_VIEW_ESCALATED,
  MOCK_VIEW_MY_OPEN,
  MOCK_VIEW_OVERDUE,
  MOCK_VIEW_UNASSIGNED,
  MOCK_VIEW_VIP,
} from '../../tickets/mock-views.js';

/**
 * M14-06 (`Admin/Tickets-Empty`): what the list says when a view holds no
 * ticket, and the keyboard hints under it. The fixture's list is emptied so
 * that each built-in view is empty without depending on the seed data.
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

const renderEmpty = async (entry: string, { singleKeys = true }: { singleKeys?: boolean } = {}) => {
  const apis = await signedInMockApis();
  if (apis.auth instanceof MockAuthApi) {
    apis.auth.saveSingleKeyShortcuts(singleKeys);
  }
  vi.spyOn(apis.tickets, 'list').mockResolvedValue({ tickets: [], nextCursor: null });
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    initialEntries: [entry],
  });
  await screen.findByRole('region', { name: 'Ticket list' });
  return rendered;
};

const hints = (): HTMLElement => screen.getByRole('list', { name: 'Keyboard hints' });

describe('the empty states of the ticket views', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [MOCK_VIEW_MY_OPEN, 'Nothing waiting on you', 'New tickets assigned to you show up here.'],
    [
      MOCK_VIEW_UNASSIGNED,
      'Every ticket has an owner',
      'New tickets without an assignee land here first.',
    ],
    [
      MOCK_VIEW_OVERDUE,
      'Nothing is past its SLA',
      'Tickets that miss a response or resolution target show up here.',
    ],
    [MOCK_VIEW_ESCALATED, 'Nothing in this view', 'No ticket matches it yet.'],
  ])('view %s says %s', async (view, heading, body) => {
    await renderEmpty(`/tickets?view=${view}`);

    expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
    expect(screen.getByText(body)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('lists the hints from the registry, with the sequence read as "g then u"', async () => {
    await renderEmpty(`/tickets?view=${MOCK_VIEW_MY_OPEN}`);
    await screen.findByRole('heading', { name: 'Nothing waiting on you' });

    const items = within(hints()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'cNew ticket',
      'gthenuUnassigned',
      '?All shortcuts',
    ]);
    expect(within(items[1] as HTMLElement).getByText('then')).toBeInTheDocument();
  });

  it('opens the sheet from the "All shortcuts" hint', async () => {
    const { user } = await renderEmpty(`/tickets?view=${MOCK_VIEW_MY_OPEN}`);
    await screen.findByRole('heading', { name: 'Nothing waiting on you' });

    await user.click(within(hints()).getByRole('button', { name: /All shortcuts/ }));

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  it('draws no hints while single-key shortcuts are off', async () => {
    await renderEmpty(`/tickets?view=${MOCK_VIEW_MY_OPEN}`, { singleKeys: false });

    expect(await screen.findByRole('heading', { name: 'Nothing waiting on you' })).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Keyboard hints' })).not.toBeInTheDocument();
  });

  it('names the search, offers Clear search, and goes back to the view', async () => {
    const { user } = await renderEmpty(`/tickets?view=${MOCK_VIEW_MY_OPEN}&q=invoice%2088`);

    expect(
      await screen.findByRole('heading', { name: 'No tickets match “invoice 88”' }),
    ).toBeVisible();
    expect(screen.getByText('Try fewer words, or search every view.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(await screen.findByRole('heading', { name: 'Nothing waiting on you' })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: /Search/ })).toHaveValue('');
  });

  it("says the view's filters exclude everything on a saved view, and Edit filters opens them", async () => {
    const { user } = await renderEmpty(`/tickets?view=${MOCK_VIEW_VIP}`);

    expect(
      await screen.findByRole('heading', { name: 'No tickets match this view' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Edit filters' }));

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Urgent' })).toBeVisible());
  });
});
