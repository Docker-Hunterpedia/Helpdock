import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_REMOTE_IMAGE, MockChannelsApi } from '../../channels/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_VAT, MockTicketsApi } from '../../tickets/mock-api.js';

/**
 * The email card and the threading-mismatch line in the thread (M2-04, M2-07,
 * the `Admin · ticket email` artboard), against the fixture's VAT ticket.
 */

beforeEach(() => {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const openVat = async (channelsApi: MockChannelsApi = new MockChannelsApi()) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    channelsApi,
    initialEntries: [`/tickets/${MOCK_TICKET_VAT}?view=all`],
  });

  const card = await screen.findByRole('article', { name: /^Email from / });

  return { ...rendered, card };
};

describe('the email card', () => {
  it('draws the header strip, the body, the inline image and the file', async () => {
    const { card } = await openVat();

    expect(within(card).getByText('<k.nasser@acme.de>')).toBeVisible();
    expect(within(card).getByText('To billing@helpdock.io')).toBeVisible();
    expect(within(card).getByText('Cc mona@example.com')).toBeVisible();
    expect(within(card).getByText(/Invoice 2291 charges 19% VAT/)).toBeVisible();
    expect(within(card).getByText('statement-sept.png · inline')).toBeVisible();
    expect(within(card).getByText('bank-statement-sept.pdf')).toBeVisible();
    // The inline image is a figure, not a chip as well.
    expect(within(card).queryByText('statement-sept.png')).not.toBeInTheDocument();
  });

  it('blocks remote images until asked, then loads them through the proxy', async () => {
    const channels = new MockChannelsApi();
    const remoteImage = vi.spyOn(channels, 'remoteImage');
    const { user, card } = await openVat(channels);

    expect(within(card).getByText('Remote images blocked · 2 from mail.acme.de')).toBeVisible();
    expect(remoteImage).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { name: 'Load images' }));

    const images = await within(card).findAllByRole('img', { name: 'Image from mail.acme.de' });
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', MOCK_REMOTE_IMAGE);
    expect(remoteImage).toHaveBeenCalledWith(
      expect.any(String),
      MOCK_TICKET_VAT,
      expect.any(String),
      1,
    );
  });

  it('says when an image could not be loaded', async () => {
    const channels = new MockChannelsApi();
    vi.spyOn(channels, 'remoteImage').mockRejectedValue(new Error('422'));
    const { user, card } = await openVat(channels);

    await user.click(within(card).getByRole('button', { name: 'Load images' }));

    expect(await within(card).findByText('Some images could not be loaded.')).toBeVisible();
  });

  it('shows and hides the quoted text', async () => {
    const { user, card } = await openVat();
    const toggle = within(card).getByRole('button', { name: 'Show quoted text' });

    expect(within(card).queryByText('Your invoice 2291 is attached.')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(within(card).getByText('Your invoice 2291 is attached.')).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Hide quoted text' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('the threading-mismatch line (DOMAIN-RULES §4.3)', () => {
  it('names the ticket, links to it and offers the merge dialog searching for it', async () => {
    const { user } = await openVat();
    const note = await screen.findByRole('note');

    expect(
      within(note).getByText(/Referenced HD-1042 but sender is not a participant/),
    ).toBeVisible();
    expect(within(note).getByRole('link', { name: 'Open HD-1042' })).toHaveAttribute(
      'href',
      expect.stringContaining('/tickets/'),
    );

    await user.click(within(note).getByRole('button', { name: 'Merge into HD-1042…' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('searchbox')).toHaveValue('HD-1042');
    });
  });

  it('keeps a plain message a bubble', async () => {
    const tickets = new MockTicketsApi();
    const page = await tickets.messages('brand', MOCK_TICKET_VAT);

    expect(page.messages.filter((message) => message.email !== undefined)).toHaveLength(2);
  });
});
