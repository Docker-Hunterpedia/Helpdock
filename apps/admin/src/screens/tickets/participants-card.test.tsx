import type { TicketParticipantList } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND, MockTicketsApi } from '../../tickets/mock-api.js';

/**
 * The Participants card of the details panel (M1-13): the contact, the CCs and
 * the field to copy somebody in, against the fixture.
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

const renderCard = async (ticketsApi?: MockTicketsApi) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: ticketsApi ?? apis.tickets,
    uploader: apis.uploader,
    initialEntries: [`/tickets/${MOCK_TICKET_REFUND}?view=all`],
  });

  const card = await screen.findByRole('region', { name: 'Participants' }, { timeout: 5_000 });
  await within(card).findByText('finance@acme.de');

  return { ...rendered, card };
};

describe('the participants card', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the contact and the CCs, each with what they are', async () => {
    const { card } = await renderCard();

    expect(within(card).getByText('Mona Khalil')).toBeInTheDocument();
    expect(within(card).getByText('contact')).toBeInTheDocument();
    expect(within(card).getByText('CC')).toBeInTheDocument();
    expect(
      within(card).getByText('CCs receive public replies and may reply by email.'),
    ).toBeInTheDocument();
  });

  it('adds a CC, normalised, and clears the field', async () => {
    const { user, card } = await renderCard();
    const field = within(card).getByRole('textbox', { name: 'Add a CC' });

    await user.type(field, ' Ops@Acme.DE ');
    await user.click(within(card).getByRole('button', { name: 'Add' }));

    expect(await within(card).findByText('ops@acme.de')).toBeInTheDocument();
    expect(field).toHaveValue('');
  });

  it('says how an address was wrong', async () => {
    const { user, card } = await renderCard();

    await user.type(within(card).getByRole('textbox', { name: 'Add a CC' }), 'not an address');
    await user.click(within(card).getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('That is not an email address.')).toBeInTheDocument();
  });

  it('removes a CC by its own labelled button', async () => {
    const { user, card } = await renderCard();

    await user.click(within(card).getByRole('button', { name: 'Remove finance@acme.de' }));

    await waitFor(() => {
      expect(within(card).queryByText('finance@acme.de')).not.toBeInTheDocument();
    });
  });

  it('says so when the api fails for another reason', async () => {
    class FailingApi extends MockTicketsApi {
      override async removeCc(): Promise<TicketParticipantList> {
        throw new Error('unavailable');
      }
    }
    const { user, card } = await renderCard(new FailingApi());

    await user.click(within(card).getByRole('button', { name: 'Remove finance@acme.de' }));

    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
  });
});
