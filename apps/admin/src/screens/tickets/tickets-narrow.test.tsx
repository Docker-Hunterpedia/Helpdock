import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * M14-22 (`Admin/Tickets-Narrow`): below 1024 px the list is the screen, a
 * ticket is pushed over it, and the way back is the button or the browser's.
 * No media query matches, which is a window narrower than every breakpoint.
 */

const narrowViewport = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
};

const renderNarrow = async (entry = '/tickets?view=all') => {
  const apis = await signedInMockApis();
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

describe('the ticket workspace below 1024 px', () => {
  beforeEach(narrowViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills the screen with the list, with no empty "No ticket open" beside it', async () => {
    await renderNarrow();

    expect(await screen.findByRole('link', { name: /HD-1042/ })).toBeVisible();
    expect(screen.queryByText('No ticket open')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show the ticket list' })).not.toBeInTheDocument();
  });

  it('pushes the ticket over the list, with a back button named for the view', async () => {
    const { user } = await renderNarrow();
    await user.click(await screen.findByRole('link', { name: /HD-1042/ }));

    await screen.findByRole('region', { name: 'Ticket header' });
    expect(screen.queryByRole('region', { name: 'Ticket list' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to All tickets' })).toBeVisible();
  });

  it('opens the details in a drawer from the bar, and only one Details button is drawn', async () => {
    const { user } = await renderNarrow();
    await user.click(await screen.findByRole('link', { name: /HD-1042/ }));
    await screen.findByRole('region', { name: 'Ticket header' });

    expect(screen.queryByRole('complementary', { name: 'Ticket details' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Details' }));

    expect(await screen.findByRole('complementary', { name: 'Ticket details' })).toBeVisible();
  });

  it('returns to the list from the back button, focusing the ticket it came from', async () => {
    const { user } = await renderNarrow();
    await user.click(await screen.findByRole('link', { name: /HD-1042/ }));
    await user.click(await screen.findByRole('button', { name: 'Back to All tickets' }));

    const row = await screen.findByRole('link', { name: /HD-1042/ });
    expect(screen.queryByRole('region', { name: 'Ticket header' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('keeps where the list was scrolled to across a ticket and back', async () => {
    const { user } = await renderNarrow();
    const rows = (await screen.findByRole('region', { name: 'Ticket list' })).querySelector('ul');
    const scroller = rows?.parentElement;
    expect(scroller).toBeDefined();
    if (scroller === null || scroller === undefined) {
      return;
    }
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);

    await user.click(await screen.findByRole('link', { name: /HD-1042/ }));
    await screen.findByRole('region', { name: 'Ticket header' });
    await user.click(screen.getByRole('button', { name: 'Back to All tickets' }));

    const again = within(await screen.findByRole('region', { name: 'Ticket list' })).getAllByRole(
      'list',
    )[0]?.parentElement;
    expect(again?.scrollTop).toBe(120);
  });

  it('leaves "[" alone, since there is no second column to put away', async () => {
    const { user } = await renderNarrow();
    await screen.findByRole('link', { name: /HD-1042/ });
    await user.keyboard('[[');

    expect(screen.getByRole('region', { name: 'Ticket list' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show the ticket list' })).not.toBeInTheDocument();
  });

  it('opens a ticket from the list with j, as it does beside the thread', async () => {
    const { user } = await renderNarrow();
    await screen.findByRole('link', { name: /HD-1042/ });
    await user.keyboard('j');

    expect(await screen.findByRole('region', { name: 'Ticket header' })).toBeVisible();
  });
});
