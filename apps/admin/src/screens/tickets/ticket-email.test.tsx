import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_UNDELIVERED_MESSAGE, MockEmailApi } from '../../email/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND, MOCK_TICKET_SIGN_IN, MockTicketsApi } from '../../tickets/mock-api.js';

/**
 * The ticket view's email half (artboard `AdminTicketEmail`, M2-05): the
 * composer's From, To, Cc and signature on a ticket that answers by email,
 * the sender a reply is sent as, and "Not delivered · Retry" in the thread.
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

const open = async (
  ticketId: string,
  emailApi = new MockEmailApi(),
  ticketsApi?: MockTicketsApi,
) => {
  const apis = await signedInMockApis();
  const tickets = ticketsApi ?? (apis.tickets as MockTicketsApi);
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: tickets,
    emailApi,
    initialEntries: [`/tickets/${ticketId}?view=all`],
  });
  await screen.findByRole('region', { name: 'Ticket list' });
  return { ...rendered, tickets, emailApi };
};

const composer = (): HTMLElement => screen.getByRole('form', { name: 'Reply or internal note' });

describe('the composer on an email ticket', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes out from the department's sender, to the contact, with the signature it will carry", async () => {
    await open(MOCK_TICKET_REFUND);

    const form = composer();
    expect(await within(form).findByRole('combobox', { name: 'From' })).toHaveTextContent(
      'Helpdock Billing <billing@helpdock.io>',
    );
    expect(within(form).getByText('mona@example.com')).toBeVisible();
    expect(within(form).getByText('Billing team · Helpdock')).toBeVisible();
    expect(within(form).getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/me/signature',
    );
    expect(within(form).getByRole('button', { name: 'Send email' })).toBeVisible();
  });

  it('sends the reply as the sender chosen in From', async () => {
    const tickets = new MockTicketsApi();
    const reply = vi.spyOn(tickets, 'reply');
    const { user } = await open(MOCK_TICKET_REFUND, new MockEmailApi(), tickets);

    await user.click(await within(composer()).findByRole('combobox', { name: 'From' }));
    await user.click(await screen.findByRole('option', { name: /support@helpdock\.io/ }));
    await user.type(within(composer()).getByRole('textbox', { name: 'Message' }), 'On its way.');
    await user.click(within(composer()).getByRole('button', { name: 'Send email' }));

    await waitFor(() => {
      expect(reply).toHaveBeenCalledWith(
        expect.any(String),
        MOCK_TICKET_REFUND,
        expect.objectContaining({ kind: 'public', emailFrom: 'default' }),
      );
    });
  });

  it('copies somebody in from the Cc line and takes them out again', async () => {
    const { user } = await open(MOCK_TICKET_REFUND);

    const add = await within(composer()).findByRole('textbox', { name: 'Add Cc' });
    await user.type(add, 'finance@example.com{Enter}');
    expect(await screen.findByText('finance@example.com added as a CC.')).toBeVisible();

    await user.click(
      await within(composer()).findByRole('button', { name: 'Remove finance@example.com' }),
    );
    expect(await screen.findByText('finance@example.com removed.')).toBeVisible();
  });

  it('leaves a note as it was: no From, no recipients', async () => {
    const { user } = await open(MOCK_TICKET_REFUND);

    await within(composer()).findByRole('combobox', { name: 'From' });
    await user.click(within(composer()).getByRole('button', { name: 'Internal note' }));

    expect(within(composer()).queryByRole('combobox', { name: 'From' })).not.toBeInTheDocument();
    expect(within(composer()).queryByText('Signature · added when sent')).not.toBeInTheDocument();
  });

  it('keeps a chat ticket out of email mode', async () => {
    await open(MOCK_TICKET_SIGN_IN);
    await screen.findByRole('heading', { name: /Cannot sign in/ });

    expect(within(composer()).queryByRole('combobox', { name: 'From' })).not.toBeInTheDocument();
    expect(within(composer()).getByRole('button', { name: 'Send reply' })).toBeVisible();
  });
});

describe('a reply that was not delivered', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says so under the reply, with the relay’s words, and retries it', async () => {
    const email = new MockEmailApi();
    const retry = vi.spyOn(email, 'retryMessage');
    const { user } = await open(MOCK_TICKET_REFUND, email);

    const thread = screen.getByRole('list', { name: 'Conversation' });
    const state = await within(thread).findByText('Not delivered');
    expect(state.parentElement).toHaveTextContent('mailbox full');
    expect(state.parentElement).toHaveTextContent('after 5 attempts');

    await user.click(within(thread).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Sent back to the queue.')).toBeVisible();
    expect(retry).toHaveBeenCalledWith(
      expect.any(String),
      MOCK_TICKET_REFUND,
      MOCK_UNDELIVERED_MESSAGE,
    );
    await waitFor(() => {
      expect(within(thread).queryByText('Not delivered')).not.toBeInTheDocument();
    });
  });

  it('says when a retry did not work', async () => {
    class Refusing extends MockEmailApi {
      override retryMessage(): Promise<void> {
        return Promise.reject(new Error('down'));
      }
    }
    const { user } = await open(MOCK_TICKET_REFUND, new Refusing());
    const thread = screen.getByRole('list', { name: 'Conversation' });

    await within(thread).findByText('Not delivered');
    await user.click(within(thread).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('That did not work. Try again.')).toBeVisible();
  });
});
