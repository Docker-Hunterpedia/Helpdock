import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockEmailApi } from '../../email/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { ReplyTargetError } from '../../tickets/api.js';
import {
  MOCK_EMAIL_SECOND,
  MOCK_TICKET_THREE_EMAILS,
  MockTicketsApi,
} from '../../tickets/mock-api.js';

/**
 * M14-31, the whole screen (`Admin/Ticket-ListToggle-ReplyTo`, notes "M14-31 · reply to one
 * message"): the Reply button on each customer email, the strip above the text, what clears
 * it, the draft it never touches, and the "In reply to" line a sent reply carries.
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

const open = async (tickets = new MockTicketsApi()) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: tickets,
    emailApi: new MockEmailApi(),
    initialEntries: [`/tickets/${MOCK_TICKET_THREE_EMAILS}?view=all`],
  });
  await screen.findByRole('list', { name: 'Conversation' });

  return { ...rendered, tickets };
};

const composer = (): HTMLElement => screen.getByRole('form', { name: 'Reply or internal note' });
const thread = (): HTMLElement => screen.getByRole('list', { name: 'Conversation' });
const replyButtons = (): HTMLElement[] =>
  within(thread()).getAllByRole('button', { name: 'Reply to Mona Khalil’s message' });
const strip = (): HTMLElement | null =>
  within(composer()).queryByRole('group', { name: 'Replying to one email' });

describe('replying to one email of a ticket', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts a Reply button on each customer email and on nothing else', async () => {
    await open();

    expect(replyButtons()).toHaveLength(3);
    // Four articles are not emails: the note and the staff reply have no button.
    expect(within(thread()).getAllByRole('button', { name: /^Reply to / })).toHaveLength(3);
    expect(within(thread()).queryByText('Internal note')).toBeVisible();
  });

  it('shows the strip, marks the email, and moves it to another without touching the draft', async () => {
    const { user } = await open();
    const body = within(composer()).getByRole('textbox', { name: 'Message' });
    await user.type(body, 'Draft in progress');

    await user.click(replyButtons()[1] as HTMLElement);
    expect(strip()).toHaveTextContent(/Replying to Mona Khalil’s email of /);
    expect(replyButtons()[1]).toHaveAttribute('aria-pressed', 'true');
    expect(replyButtons()[0]).toHaveAttribute('aria-pressed', 'false');
    expect(body).toHaveValue('Draft in progress');
    expect(body).toHaveFocus();

    await user.click(replyButtons()[2] as HTMLElement);
    expect(replyButtons()[2]).toHaveAttribute('aria-pressed', 'true');
    expect(replyButtons()[1]).toHaveAttribute('aria-pressed', 'false');
    expect(
      within(composer()).getAllByRole('group', { name: 'Replying to one email' }),
    ).toHaveLength(1);
    expect(body).toHaveValue('Draft in progress');
  });

  it('opens the quote read-only, and announces the strip once through the live region', async () => {
    const { user } = await open();

    await user.click(replyButtons()[1] as HTMLElement);
    const status = within(composer()).getByRole('status');
    expect(status).toHaveTextContent(/Replying to Mona Khalil’s email of /);

    const toggle = within(composer()).getByRole('button', { name: 'Show quote' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(composer()).getByText(/One more thing: can you also send the invoice/),
    ).toBeVisible();
    await user.click(within(composer()).getByRole('button', { name: 'Hide quote' }));
    expect(within(composer()).getByText(/One more thing/)).not.toBeVisible();
  });

  it('clears with the × button and with the Internal note tab, keeping the text', async () => {
    const { user } = await open();
    const body = within(composer()).getByRole('textbox', { name: 'Message' });
    await user.type(body, 'Kept');

    await user.click(replyButtons()[1] as HTMLElement);
    await user.click(
      within(composer()).getByRole('button', { name: 'Stop replying to this message' }),
    );
    expect(strip()).toBeNull();
    expect(replyButtons()[1]).toHaveAttribute('aria-pressed', 'false');

    await user.click(replyButtons()[1] as HTMLElement);
    await user.click(within(composer()).getByRole('button', { name: 'Internal note' }));
    expect(strip()).toBeNull();
    expect(body).toHaveValue('Kept');

    // Back on the Reply tab the strip does not come back by itself.
    await user.click(within(composer()).getByRole('button', { name: 'Reply' }));
    expect(strip()).toBeNull();
  });

  it('sends the reply to that email, clears the strip and draws "In reply to" above the reply', async () => {
    const tickets = new MockTicketsApi();
    const reply = vi.spyOn(tickets, 'reply');
    const { user } = await open(tickets);

    await user.click(replyButtons()[1] as HTMLElement);
    await user.type(
      within(composer()).getByRole('textbox', { name: 'Message' }),
      'The invoice is attached.',
    );
    await user.click(within(composer()).getByRole('button', { name: 'Send email' }));

    await screen.findByText('Reply sent');
    expect(reply).toHaveBeenCalledWith(
      expect.any(String),
      MOCK_TICKET_THREE_EMAILS,
      expect.objectContaining({ kind: 'public', replyToMessageId: MOCK_EMAIL_SECOND }),
    );
    expect(strip()).toBeNull();
    const link = await within(thread()).findByRole('button', {
      name: /^In reply to Mona Khalil, .* Go to that message$/,
    });
    expect(link).toHaveTextContent(/In reply to Mona Khalil · /);
  });

  it('sends an ordinary reply with no target', async () => {
    const tickets = new MockTicketsApi();
    const reply = vi.spyOn(tickets, 'reply');
    const { user } = await open(tickets);

    await user.type(within(composer()).getByRole('textbox', { name: 'Message' }), 'On its way.');
    await user.click(within(composer()).getByRole('button', { name: 'Send email' }));

    await screen.findByText('Reply sent');
    expect(reply.mock.calls[0]?.[2]).not.toHaveProperty('replyToMessageId');
    expect(within(thread()).queryByText(/^In reply to /)).toBeNull();
  });

  it('keeps the text and says the email is gone when the api refuses the target', async () => {
    const tickets = new MockTicketsApi();
    vi.spyOn(tickets, 'reply').mockRejectedValue(new ReplyTargetError('gone'));
    const { user } = await open(tickets);

    await user.click(replyButtons()[1] as HTMLElement);
    await user.type(
      within(composer()).getByRole('textbox', { name: 'Message' }),
      'The invoice is attached.',
    );
    await user.click(within(composer()).getByRole('button', { name: 'Send email' }));

    expect(
      await within(composer()).findByText('That message is no longer available'),
    ).toBeVisible();
    expect(within(composer()).getByRole('textbox', { name: 'Message' })).toHaveValue(
      'The invoice is attached.',
    );
    expect(within(composer()).getByRole('button', { name: 'Send email' })).toBeDisabled();

    // Clearing the strip lets the text go as an ordinary reply.
    await user.click(
      within(composer()).getByRole('button', { name: 'Stop replying to this message' }),
    );
    await waitFor(() => {
      expect(within(composer()).getByRole('button', { name: 'Send email' })).toBeEnabled();
    });
  });
});
