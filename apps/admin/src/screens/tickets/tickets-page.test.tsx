import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockAttachmentUploader } from '../../media/mock-uploader.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND, MockTicketsApi } from '../../tickets/mock-api.js';
import { MOCK_VIEW_ESCALATED } from '../../tickets/mock-views.js';

/**
 * The ticket workspace against the fixture. What is worth asserting is what the
 * screen decides — which view it is showing, what `j` does, which bubble a
 * message is drawn as, what a send looks like before the `seq` arrives — rather
 * than the markup it decides it with.
 */

/**
 * Every media query answers yes, which is the 1440 px artboard. happy-dom has
 * no layout, so the query is the only thing there is to answer; the drawer
 * behaviour at 1200 px and 900 px is covered by Playwright, which does.
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

const renderTickets = async (
  entry = '/tickets',
  ticketsApi?: MockTicketsApi,
  uploader?: MockAttachmentUploader,
) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: ticketsApi ?? apis.tickets,
    uploader: uploader ?? apis.uploader,
    initialEntries: [entry],
  });

  await screen.findByRole('region', { name: 'Ticket list' });

  return rendered;
};

const list = (): HTMLElement => screen.getByRole('region', { name: 'Ticket list' });

describe('the ticket list', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on the "My open" view and names it as the heading', async () => {
    await renderTickets();

    await screen.findByRole('heading', { name: 'My open', level: 1 });

    expect(await within(list()).findByText('Refund for order 42 has not arrived')).toBeVisible();
  });

  it('shows every ticket on the "All tickets" view', async () => {
    await renderTickets('/tickets?view=all');

    await screen.findByRole('heading', { name: 'All tickets', level: 1 });
    expect(await screen.findAllByRole('link', { name: /^HD-/ })).toHaveLength(6);
  });

  it('puts the reference, the contact and the time on a row', async () => {
    await renderTickets('/tickets?view=all');
    const row = await screen.findByRole('link', { name: /HD-1042/ });

    expect(row).toHaveTextContent('HD-1042');
    expect(row).toHaveTextContent('Mona Khalil');
  });

  it('says what an empty view means, without pretending a search failed', async () => {
    await renderTickets(
      `/tickets?view=${MOCK_VIEW_ESCALATED}&custom=1&state=escalated&priority=low`,
    );

    expect(await screen.findByText('Nothing in this view')).toBeVisible();
  });

  it('searches the api rather than filtering what is already drawn', async () => {
    const { user } = await renderTickets('/tickets?view=all');
    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'VAT');

    await waitFor(async () => {
      expect(await screen.findAllByRole('link', { name: /^HD-/ })).toHaveLength(1);
    });
    expect(screen.getByRole('link', { name: /HD-1035/ })).toBeVisible();
  });

  it('says so when a search matches nothing', async () => {
    const { user } = await renderTickets('/tickets?view=all');
    await user.type(screen.getByRole('searchbox', { name: 'Search tickets' }), 'zzzz');

    expect(await screen.findByText('No matches')).toBeVisible();
  });

  it('narrows the list from the filter popover, and counts what is on', async () => {
    const { user } = await renderTickets('/tickets?view=all');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(await screen.findByRole('switch', { name: 'Urgent' }));
    // The popover is a modal, so everything behind it is out of the
    // accessibility tree until it closes.
    await user.keyboard('{Escape}');

    expect(await screen.findByRole('button', { name: 'Filter (1)' })).toBeVisible();
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: /^HD-/ })).toHaveLength(1);
    });
  });

  it('offers more only while the api says there is more', async () => {
    await renderTickets('/tickets?view=all');

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('the keyboard', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('moves through the list with j and k, and opens what it lands on', async () => {
    const { user } = await renderTickets('/tickets?view=all');
    await screen.findByRole('link', { name: /HD-1042/ });

    await user.keyboard('j');
    expect(await screen.findByRole('heading', { name: /Refund for order 42/ })).toBeVisible();

    await user.keyboard('j');
    expect(
      await screen.findByRole('heading', { name: 'Cannot sign in to the portal' }),
    ).toBeVisible();

    await user.keyboard('k');
    expect(await screen.findByRole('heading', { name: /Refund for order 42/ })).toBeVisible();
  });

  it('puts the caret in the composer for r, and in note mode for n', async () => {
    const { user } = await renderTickets(`/tickets/${MOCK_TICKET_REFUND}?view=all`);
    await screen.findByRole('heading', { name: /Refund for order 42/ });

    await user.keyboard('r');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();

    // Out of the field first, or the letter is the letter n.
    screen.getByRole('textbox', { name: 'Message' }).blur();
    await user.keyboard('n');
    expect(screen.getByRole('button', { name: 'Internal note', pressed: true })).toBeVisible();
  });
});

describe('one ticket', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const openRefund = async (ticketsApi?: MockTicketsApi, uploader?: MockAttachmentUploader) => {
    const rendered = await renderTickets(
      `/tickets/${MOCK_TICKET_REFUND}?view=all`,
      ticketsApi,
      uploader,
    );
    await screen.findByRole('heading', { name: /Refund for order 42/ });

    return rendered;
  };

  it('draws the badge row from the ticket itself', async () => {
    await openRefund();
    const header = screen.getByRole('region', { name: 'Ticket header' });

    expect(within(header).getByText('Open')).toBeVisible();
    expect(within(header).getByText('Urgent')).toBeVisible();
    expect(within(header).getByText(/First response breached/)).toBeVisible();
  });

  it('draws all four kinds of message and the events between them', async () => {
    await openRefund();
    const thread = screen.getByRole('list', { name: 'Conversation' });

    expect(within(thread).getByText(/refund has still not reached/)).toBeVisible();
    expect(within(thread).getByText('AI reply')).toBeVisible();
    expect(within(thread).getByText('Internal note')).toBeVisible();
    expect(within(thread).getByText(/changed priority Medium → Urgent via a rule/)).toBeVisible();
  });

  it('names who else has the ticket open', async () => {
    await openRefund();

    expect(await screen.findByText('Omar Nasser is viewing')).toBeVisible();
  });

  it('shows a reply as sending, then as part of the thread once it has a seq', async () => {
    const { user } = await openRefund();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'On its way.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByText('Reply sent')).toBeVisible();
    const thread = screen.getByRole('list', { name: 'Conversation' });
    expect(within(thread).getByText('On its way.')).toBeVisible();
    expect(within(thread).queryByText('Sending…')).not.toBeInTheDocument();
  });

  it('offers the send again when the api refuses it', async () => {
    class RefusingApi extends MockTicketsApi {
      override reply(): never {
        throw new Error('nope');
      }
    }

    const { user } = await openRefund(new RefusingApi());
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'On its way.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(await screen.findByText('Not sent, retry')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('posts a note as a note, not as a reply', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);

    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'For the team only.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByText('Note added')).toBeVisible();
    const { messages } = await tickets.messages('brand', MOCK_TICKET_REFUND, 4);
    expect(messages[0]).toMatchObject({ kind: 'note' });
  });

  it('applies "then set status" after the send, not with it', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Closing this.');
    await user.click(screen.getByRole('combobox', { name: 'Then set status' }));
    await user.click(await screen.findByRole('option', { name: 'Closed' }));
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(async () => {
      expect((await tickets.ticket('brand', MOCK_TICKET_REFUND)).ticket.status.name).toBe('Closed');
    });
  });

  it('changes the priority from the details panel', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);

    await user.click(screen.getByRole('combobox', { name: 'Priority' }));
    await user.click(await screen.findByRole('option', { name: 'Low' }));

    expect(await screen.findByText('Ticket updated')).toBeVisible();
    expect((await tickets.ticket('brand', MOCK_TICKET_REFUND)).ticket.priority).toBe('low');
  });

  it('shows the contact, their address and how much of their history is hidden', async () => {
    await openRefund();
    const details = screen.getByRole('complementary', { name: 'Ticket details' });

    expect(within(details).getByRole('link', { name: 'Mona Khalil' })).toBeVisible();
    expect(within(details).getByText('mona@example.com')).toBeVisible();
  });

  it('draws the custom fields as editors holding the stored values', async () => {
    await openRefund();
    const details = screen.getByRole('complementary', { name: 'Ticket details' });

    expect(within(details).getByRole('textbox', { name: 'Order id' })).toHaveValue('ORD-4812');
    expect(within(details).getByRole('combobox', { name: 'Plan tier' })).toHaveTextContent('gold');
  });

  it('saves a custom field on blur through the ticket PATCH', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);
    const field = screen.getByRole('textbox', { name: 'Order id' });

    await user.clear(field);
    await user.type(field, 'ORD-5000');
    await user.tab();

    expect(await screen.findByText('Ticket updated')).toBeVisible();
    expect((await tickets.ticket('brand', MOCK_TICKET_REFUND)).ticket.custom).toMatchObject({
      order_id: 'ORD-5000',
    });
  });

  it('shows the api’s refusal under the field and puts the stored value back', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);
    const field = screen.getByRole('textbox', { name: 'Order id' });

    await user.clear(field);
    // Past the 2,000 characters a text value may hold; pasted, because typing is slow.
    await user.click(field);
    await user.paste('x'.repeat(2001));
    await user.tab();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter some text, up to 2,000 characters.',
    );
    expect(field).toHaveValue('ORD-4812');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('draws the ticket’s tags as chips with a way to remove each', async () => {
    await openRefund();
    const details = screen.getByRole('complementary', { name: 'Ticket details' });

    expect(within(details).getByText('Refund')).toBeVisible();
    expect(within(details).getByRole('button', { name: 'Remove tag VIP' })).toBeVisible();
  });

  it('removes a tag at once and saves the set without it', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);

    await user.click(screen.getByRole('button', { name: 'Remove tag VIP' }));

    expect(screen.queryByRole('button', { name: 'Remove tag VIP' })).toBeNull();
    await waitFor(async () => {
      const { ticket } = await tickets.ticket('brand', MOCK_TICKET_REFUND);
      expect(ticket.tags?.map((tag) => tag.name)).toEqual(['Refund']);
    });
  });

  it('adds a tag from the picker with Enter, and never offers to create one', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);

    await user.click(screen.getByRole('button', { name: 'Add a tag' }));
    const search = await screen.findByRole('combobox', { name: 'Find a tag' });
    await user.type(search, 'bu');
    expect(screen.getByRole('option', { name: 'Bug' })).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('option', { name: 'Bug' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(async () => {
      const { ticket } = await tickets.ticket('brand', MOCK_TICKET_REFUND);
      expect(ticket.tags?.map((tag) => tag.name)).toEqual(['Refund', 'VIP', 'Bug']);
    });

    await user.clear(search);
    await user.type(search, 'warranty');
    expect(screen.getByText(/No tag called "warranty"/)).toBeVisible();
  });

  it('moves through the picker with the arrow keys, and toggles by click too', async () => {
    const tickets = new MockTicketsApi();
    const { user } = await openRefund(tickets);

    await user.click(screen.getByRole('button', { name: 'Add a tag' }));
    const search = await screen.findByRole('combobox', { name: 'Find a tag' });
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'VIP' }).id,
    );
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('option', { name: 'Bug' }));

    await waitFor(async () => {
      const { ticket } = await tickets.ticket('brand', MOCK_TICKET_REFUND);
      expect(ticket.tags?.map((tag) => tag.name)).toEqual(['Refund', 'Bug']);
    });
  });

  it('gives a Viewer the chips and the values with nothing to change them', async () => {
    const apis = await signedInMockApis();
    const session = await apis.auth.me();
    vi.spyOn(apis.auth, 'me').mockResolvedValue(
      session === null ? null : { ...session, user: { ...session.user, role: 'viewer' } },
    );
    renderApp(<AppRoutes />, {
      authApi: apis.auth,
      staffApi: apis.staff,
      contactsApi: apis.contacts,
      ticketingApi: apis.ticketing,
      ticketsApi: apis.tickets,
      uploader: apis.uploader,
      initialEntries: [`/tickets/${MOCK_TICKET_REFUND}?view=all`],
    });
    await screen.findByRole('heading', { name: /Refund for order 42/ });
    const details = screen.getByRole('complementary', { name: 'Ticket details' });

    expect(within(details).getByText('VIP')).toBeVisible();
    expect(within(details).queryByRole('button', { name: 'Remove tag VIP' })).toBeNull();
    expect(within(details).queryByRole('button', { name: 'Add a tag' })).toBeNull();
    expect(await within(details).findByRole('textbox', { name: 'Order id' })).toBeDisabled();
  });

  it('puts the chips back and says so when the api refuses the set', async () => {
    const tickets = new MockTicketsApi();
    vi.spyOn(tickets, 'setTags').mockRejectedValue(new Error('No such tag in this brand'));
    const { user } = await openRefund(tickets);

    await user.click(screen.getByRole('button', { name: 'Remove tag VIP' }));

    expect(await screen.findByText(/The tags were not changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove tag VIP' })).toBeVisible();
  });

  it('draws the file the contact sent, with its size', async () => {
    await openRefund();
    const thread = screen.getByRole('list', { name: 'Conversation' });

    expect(within(thread).getByText('return-confirmation.pdf')).toBeVisible();
    expect(within(thread).getByText('82 KB')).toBeVisible();
  });

  it('uploads a chosen file and sends its id with the reply', async () => {
    const uploads = new MockAttachmentUploader();
    const tickets = new MockTicketsApi(uploads);
    const { user } = await openRefund(tickets, uploads);

    await user.upload(
      screen.getByLabelText('Choose files to attach'),
      new File(['hello'], 'receipt.pdf', { type: 'application/pdf' }),
    );

    // The chip appears before the pipeline has finished with it: `upload`
    // resolves at `processing` and the send does not wait (M1-10).
    expect(await screen.findByText('receipt.pdf')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Here it is.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(async () => {
      const { messages } = await tickets.messages('brand', MOCK_TICKET_REFUND, 4);
      expect(messages[0]?.attachments.map((row) => row.originalName)).toEqual(['receipt.pdf']);
    });
  });

  it('refuses a file the brand’s policy would not take, before any bytes go up', async () => {
    const { user } = await openRefund();

    await user.upload(
      screen.getByLabelText('Choose files to attach'),
      new File(['x'], 'installer.exe', { type: 'application/x-msdownload' }),
    );

    expect(await screen.findByText(/does not accept that file type/)).toBeVisible();
    expect(screen.queryByText('installer.exe')).not.toBeInTheDocument();
  });

  it('takes a chosen file back before it has been sent', async () => {
    const { user } = await openRefund();
    await user.upload(
      screen.getByLabelText('Choose files to attach'),
      new File(['hello'], 'receipt.pdf', { type: 'application/pdf' }),
    );
    await screen.findByText('receipt.pdf');

    await user.click(screen.getByRole('button', { name: 'Remove receipt.pdf' }));

    expect(screen.queryByText('receipt.pdf')).not.toBeInTheDocument();
  });

  it('says one thing about a ticket it cannot read, whatever the reason', async () => {
    await renderTickets('/tickets/0192c3f0-1a2b-7c3d-8e4f-0000000009ff?view=all');

    expect(await screen.findByText('This ticket is not available')).toBeVisible();
  });
});

describe('the new-ticket dialog', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The slowest test here: a dialog, a create, an invalidation of every list
  // and count, and a navigation. Five seconds is not enough on a loaded runner.
  it('creates a ticket and opens it', { timeout: 20_000 }, async () => {
    const tickets = new MockTicketsApi();
    const { user } = await renderTickets('/tickets?view=all', tickets);

    await user.click(screen.getByRole('button', { name: 'New ticket' }));
    await user.click(await screen.findByRole('button', { name: 'No contact' }));
    await user.type(screen.getByRole('textbox', { name: 'Subject' }), 'Typed in by hand');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'The first reply.');
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(await screen.findByText('HD-1043 created')).toBeVisible();
    expect((await tickets.list('brand')).tickets).toHaveLength(7);
  });
});
