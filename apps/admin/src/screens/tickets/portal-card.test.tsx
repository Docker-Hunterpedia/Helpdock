import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_BRAND } from '../../contacts/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND, MOCK_TICKET_SIGN_IN } from '../../tickets/mock-api.js';

/**
 * The "Customer portal" card of the details panel and the Participants chips
 * (M21-06), against the fixture: the private switch, the line that says who
 * sees the ticket, and how each CC was added.
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

const renderTicket = async ({
  portalOn = true,
  ticketId = MOCK_TICKET_SIGN_IN,
}: {
  portalOn?: boolean;
  ticketId?: string;
} = {}) => {
  const apis = await signedInMockApis();
  if (portalOn) {
    await apis.ticketing.updatePortalSettings(MOCK_BRAND, {
      enabled: true,
      newCustomers: false,
      departmentIds: 'all',
    });
  }
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    initialEntries: [`/tickets/${ticketId}?view=all`],
  });
  await screen.findByRole('region', { name: 'Participants' }, { timeout: 5_000 });

  return { ...rendered, apis };
};

describe('the details panel’s Customer portal card', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says who sees the ticket now, and marks it private with the switch', async () => {
    const { user, apis } = await renderTicket({ ticketId: MOCK_TICKET_REFUND });
    const card = await screen.findByRole('region', { name: 'Customer portal' });

    expect(within(card).getByText(/Now visible to:/)).toHaveTextContent(
      'Now visible to: Mona Khalil · all of Acme GmbH',
    );
    const toggle = within(card).getByRole('switch', { name: 'Private to the requester' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    expect(await screen.findByText('Marked private to the requester')).toBeVisible();
    await waitFor(() => {
      expect(
        within(card).getByRole('switch', { name: 'Private to the requester' }),
      ).toHaveAttribute('aria-checked', 'true');
    });
    expect(within(card).getByText(/Now visible to:/)).toHaveTextContent(
      'Now visible to: Mona Khalil',
    );
    expect(within(card).getByText(/Now visible to:/)).not.toHaveTextContent('Acme');
    const detail = await apis.tickets.ticket(MOCK_BRAND, MOCK_TICKET_REFUND);
    expect(detail.portal?.private).toBe(true);
  });

  it('writes the change into the thread as an activity line', async () => {
    const { user } = await renderTicket({ ticketId: MOCK_TICKET_REFUND });
    const card = await screen.findByRole('region', { name: 'Customer portal' });

    await user.click(within(card).getByRole('switch', { name: 'Private to the requester' }));

    expect(await screen.findByText(/marked this ticket private to the requester/)).toBeVisible();
  });

  it('is not drawn while the brand’s portal is off', async () => {
    await renderTicket({ portalOn: false, ticketId: MOCK_TICKET_REFUND });

    expect(screen.queryByRole('region', { name: 'Customer portal' })).not.toBeInTheDocument();
  });
});

describe('the participants card with the portal on', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says how each CC was added, who sees the ticket in the portal, and why a mail CC does not', async () => {
    const { user } = await renderTicket();
    const card = screen.getByRole('region', { name: 'Participants' });
    await user.click(within(card).getByRole('button', { name: /participants? · Add CC$/ }));

    const staffAdded = (await within(card).findByText('omar@acme.example')).closest('li');
    expect(staffAdded).not.toBeNull();
    expect(within(staffAdded as HTMLElement).getByText('Added by Lina Haddad')).toBeVisible();
    expect(within(staffAdded as HTMLElement).getByText('Sees it in the portal')).toBeVisible();

    const mailCc = (await within(card).findByText('sara@acme.example')).closest('li');
    expect(within(mailCc as HTMLElement).getByText('From email Cc')).toBeVisible();
    expect(
      within(mailCc as HTMLElement).queryByText('Sees it in the portal'),
    ).not.toBeInTheDocument();
    expect(
      within(card).getByText(/Someone copied on an email gets the replies by email only/),
    ).toBeVisible();
  });

  it('keeps the portal wording out of the card while the portal is off', async () => {
    const { user } = await renderTicket({ portalOn: false });
    const card = screen.getByRole('region', { name: 'Participants' });
    await user.click(within(card).getByRole('button', { name: /participants? · Add CC$/ }));

    await within(card).findByText('omar@acme.example');
    expect(within(card).queryByText('Sees it in the portal')).not.toBeInTheDocument();
    expect(within(card).queryByText(/Someone copied on an email/)).not.toBeInTheDocument();
  });
});
