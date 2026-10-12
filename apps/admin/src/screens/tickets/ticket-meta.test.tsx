import type { TicketMessage } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockAttachmentUploader } from '../../media/mock-uploader.js';
import { MetaError } from '../../meta/api.js';
import { MockMetaApi } from '../../meta/mock-api.js';
import {
  MOCK_META_CONVERSATIONS,
  MOCK_TICKET_INSTAGRAM,
  MOCK_TICKET_MESSENGER,
  MOCK_TICKET_WHATSAPP,
} from '../../meta/mock-conversations.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND, type MockTicketsApi } from '../../tickets/mock-api.js';

/**
 * The ticket view's Meta half (artboard `Admin/Ticket-Meta`, M10-08): the channel
 * chip with the account, "via" and "to", every delivery state, the strips under a
 * reply, the quote, the sticker and the story, the ReplyWindowStrip, the
 * ChannelIdentityCard and the composer in Meta mode.
 *
 * The clock is fixed at 10:31 local on 11 October 2026, so the fixture's windows
 * read the same on every machine: the WhatsApp customer wrote at 09:25 (22 h 54 m
 * left), the Messenger one 30 hours ago (5 d 18 h of Human Agent days left) and
 * the Instagram one 8 days ago (closed).
 */

const NOW = new Date(2026, 9, 11, 10, 31, 0);

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

const open = async (ticketId: string, metaApi = new MockMetaApi(), meta = true) => {
  const apis = await signedInMockApis();
  const uploader = new MockAttachmentUploader();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets as MockTicketsApi,
    metaApi,
    uploader,
    initialEntries: [`/tickets/${ticketId}?view=all`],
  });
  await screen.findByRole('region', { name: 'Ticket list' });
  // The thread and the strip arrive after the list does.
  await screen.findByRole('list', { name: 'Conversation' });
  if (meta) {
    // The window is read after the thread is drawn, and the thread is drawn
    // again with its Meta lines once it has: wait for it, so a query made next
    // does not hold an element that is about to be replaced.
    await screen.findByText(/Reply window|Human Agent window/);
  }
  return { ...rendered, metaApi, tickets: apis.tickets as MockTicketsApi };
};

const thread = (): HTMLElement => screen.getByRole('list', { name: 'Conversation' });
const composer = (): HTMLElement => screen.getByRole('form', { name: 'Reply or internal note' });
const strip = async (): Promise<HTMLElement> => {
  const found = await screen.findByText(/Reply window|Human Agent window/);
  const status = found.closest('[role="status"]');
  if (!(status instanceof HTMLElement)) {
    throw new Error('the strip is not a role="status"');
  }
  return status;
};

beforeEach(() => {
  wideViewport();
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a WhatsApp ticket', () => {
  it('names the number the ticket is with in the header, and the account under each message', async () => {
    await open(MOCK_TICKET_WHATSAPP);

    const header = screen.getByRole('region', { name: 'Ticket header' });
    expect(await within(header).findByText(/WhatsApp · \+1 555 0142 · Support/)).toBeVisible();
    expect(within(thread()).getAllByText('via +1 555 0142').length).toBeGreaterThan(0);
    expect(within(thread()).getAllByText('to WhatsApp').length).toBeGreaterThan(0);
  });

  it('says where every reply stands, and names that state to a screen reader', async () => {
    await open(MOCK_TICKET_WHATSAPP);

    expect(await within(thread()).findByText('Read')).toBeVisible();
    expect(within(thread()).getByText('Delivered')).toBeVisible();
    expect(within(thread()).getByText('Sent')).toBeVisible();
    expect(within(thread()).getByText('Sending · part 2 of 3')).toBeVisible();
    expect(within(thread()).getAllByText('2 messages').length).toBeGreaterThan(0);
    expect(
      within(thread()).getByRole('article', { name: 'Reply from Lina Haddad, read' }),
    ).toBeVisible();
    expect(
      within(thread()).getByRole('article', { name: 'Reply from Lina Haddad, sending' }),
    ).toBeVisible();
  });

  it('draws a quoted message as a leading quote with the author, and a sticker as a figure', async () => {
    await open(MOCK_TICKET_WHATSAPP);

    const quote = await within(thread()).findByLabelText('Quoted message');
    expect(quote).toHaveTextContent(
      'Lina Haddad: Sorry about that, Daniel. Could you send a photo of the label on the box too?',
    );
    expect(within(thread()).getByText('Here it is.')).toBeVisible();
    // The customer's words decide their own direction, so an Arabic admin keeps an English sentence's punctuation.
    expect(within(thread()).getByText('Here it is.').closest('[dir="auto"]')).not.toBeNull();
    expect(within(thread()).getByRole('img', { name: 'Sticker' })).toBeVisible();
    // A sticker is a figure, not a file chip.
    expect(within(thread()).queryByText('sticker.webp')).toBeNull();
  });

  it('says a reply was refused because the window had closed, and offers no Retry', async () => {
    await open(MOCK_TICKET_WHATSAPP);

    const refused = await within(thread()).findByText('Not sent');
    expect(refused.parentElement).toHaveTextContent(
      'the reply window had closed · WhatsApp: “Message failed to send because more than 24 hours have passed since the customer last replied to this number.” (131047)',
    );
    expect(
      within(thread()).getByText('No Retry: write a new reply once the customer writes again.'),
    ).toBeVisible();
    expect(within(thread()).queryByRole('button', { name: /Retry sending/ })).toBeNull();
  });

  it('shows the open window in the strip, with the closing time as a time', async () => {
    await open(MOCK_TICKET_WHATSAPP);

    const status = await strip();
    expect(status).toHaveTextContent(
      'Reply window open · 22h 54m left · closes tomorrow at 09:25WhatsApp · 24 hours after the customer’s last message',
    );
    const closes = within(status).getByText('tomorrow at 09:25');
    expect(closes.tagName).toBe('TIME');
    expect(closes).toHaveAttribute('dateTime', new Date(2026, 9, 12, 9, 25).toISOString());
    // The countdown is not read; the state and the closing time are.
    expect(
      within(status)
        .getByText(/22h 54m/)
        .closest('[aria-hidden="true"]'),
    ).not.toBeNull();
  });

  it('shows who the customer is under the contact, and copies the user id', async () => {
    const { user } = await open(MOCK_TICKET_WHATSAPP);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const card = await screen.findByRole('region', { name: 'WhatsApp identity' });
    expect(within(card).getByText('US.13491208655302741918')).toBeVisible();
    expect(within(card).getByText('+44 7700 900123')).toBeVisible();
    expect(within(card).getByText('verified')).toBeVisible();
    expect(within(card).getByText('Daniel R.')).toBeVisible();
    expect(within(card).getByText('+1 555 0142')).toBeVisible();
    expect(within(card).getByText('Helpdock Support')).toBeVisible();
    expect(within(card).getByText(/The user id and the phone are verified by Meta/)).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Copy user id' }));
    expect(writeText).toHaveBeenCalledWith('US.13491208655302741918');
  });

  it('says where a reply goes, and counts the messages it becomes, charge included', async () => {
    const { user } = await open(MOCK_TICKET_WHATSAPP);

    await screen.findByLabelText('Quoted message');
    expect(composer()).toHaveTextContent(
      'To Daniel Reyes on WhatsApp +44 7700 900123 · from +1 555 0142',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'The courier comes tomorrow.',
    );
    expect(await within(composer()).findByText(/Plain text\./)).toHaveTextContent(
      'Plain text. Sent as 1 message. Meta may charge for it.',
    );

    await user.upload(
      screen.getByLabelText('Choose files to attach'),
      new File(['hello'], 'receipt.pdf', { type: 'application/pdf' }),
    );
    await screen.findByText('receipt.pdf');
    expect(within(composer()).getByText(/Plain text\./)).toHaveTextContent(
      'Plain text. Sent as 2 messages: 1 text, 1 attachment. Meta may charge for each.',
    );
  });

  it('counts the opening line a files-only reply carries as one text message', async () => {
    const { user } = await open(MOCK_TICKET_WHATSAPP);
    await user.upload(
      screen.getByLabelText('Choose files to attach'),
      new File(['hello'], 'receipt.pdf', { type: 'application/pdf' }),
    );
    await screen.findByText('receipt.pdf');

    expect(within(composer()).getByText(/Plain text\./)).toHaveTextContent(
      'Plain text. Sent as 2 messages: 1 text, 1 attachment.',
    );
  });

  it('sends while the window is open', async () => {
    const { user, tickets } = await open(MOCK_TICKET_WHATSAPP);
    const reply = vi.spyOn(tickets, 'reply');

    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'The courier comes tomorrow.',
    );
    const send = screen.getByRole('button', { name: 'Send reply' });
    expect(send).not.toHaveAttribute('aria-disabled');
    await user.click(send);

    await waitFor(() => {
      expect(reply).toHaveBeenCalledTimes(1);
    });
  });
});

describe('a Messenger ticket', () => {
  it('shows the Human Agent days, and leaves Send on for a person', async () => {
    await open(MOCK_TICKET_MESSENGER);

    const status = await strip();
    expect(status).toHaveTextContent(
      'Human Agent window · 5d 18h left · closes Saturday at 04:31. Only a person’s reply may use it; AI and rule replies stopped at 24 hours.Messenger · 7 days',
    );
    expect(screen.getByRole('button', { name: 'Send reply' })).not.toHaveAttribute('aria-disabled');
  });

  it('says part 2 of 2 failed, what reached the customer, and retries from there', async () => {
    const { user, metaApi } = await open(MOCK_TICKET_MESSENGER);
    const retry = vi.spyOn(metaApi, 'retryDelivery');

    const failure = await within(thread()).findByText('Not delivered');
    expect(failure.parentElement).toHaveTextContent(
      'part 2 of 2 · Messenger: “(#1200) Temporary send message failure. Please try again later.” (1200) · 5 attempts',
    );
    expect(
      within(thread()).getByText('The first part reached the customer; Retry sends the rest.'),
    ).toBeVisible();

    await user.click(
      within(thread()).getByRole('button', { name: 'Retry sending this reply to Messenger' }),
    );
    await waitFor(() => {
      expect(retry).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(within(thread()).queryByText('Not delivered')).toBeNull();
    });
    expect(await screen.findByText('Sending the reply again')).toBeVisible();
  });

  it('draws a reaction as a line of the thread', async () => {
    await open(MOCK_TICKET_MESSENGER);

    expect(
      await within(thread()).findByText('The customer reacted 👍 to a message.'),
    ).toBeVisible();
  });

  it('shows "Messenger user" and the Page, and says Meta shares no phone', async () => {
    await open(MOCK_TICKET_MESSENGER);

    const header = screen.getByRole('region', { name: 'Ticket header' });
    expect(await within(header).findByText(/Messenger · Helpdock · Support/)).toBeVisible();
    const card = await screen.findByRole('region', { name: 'Messenger identity' });
    expect(within(card).getByText('7120458839201457')).toBeVisible();
    expect(within(card).getByText('Messenger user')).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Copy page-scoped id' })).toBeVisible();
    expect(within(card).getByText(/Meta shares no phone or email/)).toBeVisible();
    expect(composer()).toHaveTextContent('To Messenger user on Messenger · from Helpdock');
  });
});

describe('an Instagram ticket', () => {
  it('says the window closed, when, and what an agent can still do', async () => {
    await open(MOCK_TICKET_INSTAGRAM);

    const status = await strip();
    expect(status).toHaveTextContent(
      'Reply window closed · It closed 7 days ago, Oct 4 at 09:36. Instagram accepts no reply until Sara M. writes again. You can still add an internal note.',
    );
  });

  it('holds Send, described by the strip, and sends nothing while it is held', async () => {
    const { user, tickets } = await open(MOCK_TICKET_INSTAGRAM);
    const reply = vi.spyOn(tickets, 'reply');
    const status = await strip();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello Sara');
    const send = screen.getByRole('button', { name: 'Send reply' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).not.toBeDisabled();
    expect(send).toHaveAttribute('aria-describedby', status.id);
    expect(within(composer()).getByText(/Would go as/)).toHaveTextContent(
      'Plain text. Would go as 1 message; Send turns on when Sara M. writes again.',
    );

    await user.click(send);
    expect(reply).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello Sara');
  });

  it('never refuses an internal note', async () => {
    const { user, tickets } = await open(MOCK_TICKET_INSTAGRAM);
    const reply = vi.spyOn(tickets, 'reply');
    await strip();

    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Sara asked twice.');
    const add = screen.getByRole('button', { name: 'Add note' });
    expect(add).not.toHaveAttribute('aria-disabled');
    await user.click(add);

    await waitFor(() => {
      expect(reply).toHaveBeenCalledWith(
        expect.anything(),
        MOCK_TICKET_INSTAGRAM,
        expect.objectContaining({ kind: 'note' }),
      );
    });
  });

  it('draws a story reply as a caption over a figure, and the lines nobody wrote', async () => {
    await open(MOCK_TICKET_INSTAGRAM);

    expect(await within(thread()).findByText('Replied to your story')).toBeVisible();
    expect(
      within(thread()).getByRole('img', { name: /^Story · Oct 3 · kept until it expires$/ }),
    ).toBeVisible();
    expect(within(thread()).getByText('Is the green one back in stock?')).toBeVisible();
    // The story's media is the figure, not a chip as well.
    expect(within(thread()).queryByText('story.jpg')).toBeNull();
    expect(
      within(thread()).getByText('The customer sent something that cannot be shown here.'),
    ).toBeVisible();
  });

  it('marks the message the customer unsent on the message itself, and draws no second line for it', async () => {
    await open(MOCK_TICKET_INSTAGRAM);

    const caption = await within(thread()).findByText('Unsent by the customer');
    const bubble = caption.closest('article');
    // The message keeps its words; the caption is under them, with the time Instagram said.
    expect(bubble).toHaveTextContent('Also the lid in blue?');
    expect(caption.parentElement).toHaveTextContent('Unsent by the customer · 08:32');
    // The system line that marks it is not drawn beside it.
    expect(within(thread()).queryByText('The customer unsent this message.')).toBeNull();
    // Only that message is marked.
    expect(within(thread()).getAllByText('Unsent by the customer')).toHaveLength(1);
  });

  it('names the file Instagram would not take, under the reply that left it out', async () => {
    await open(MOCK_TICKET_INSTAGRAM);

    const line = await within(thread()).findByText(/left out:/);
    expect(line).toHaveTextContent(
      'warranty-terms.docx left out: Instagram sends PDF files only. The customer was told.',
    );
  });

  it('shows the Instagram identity, with the @username', async () => {
    await open(MOCK_TICKET_INSTAGRAM);

    const card = await screen.findByRole('region', { name: 'Instagram identity' });
    expect(within(card).getByText('6829104477310925')).toBeVisible();
    expect(within(card).getByText('@sara.makes')).toBeVisible();
    expect(within(card).getByText('Sara M.')).toBeVisible();
    expect(within(card).getAllByText('@helpdock')).toHaveLength(2);
    expect(card).toHaveTextContent('is this person on @helpdock only');
  });

  it('warns before Send that a Word file will be left out, and counts without it', async () => {
    const { user } = await open(MOCK_TICKET_INSTAGRAM);
    await user.upload(
      screen.getByLabelText('Choose files to attach'),
      new File(['x'], 'terms.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );

    expect(await within(composer()).findByText(/will be left out/)).toHaveTextContent(
      'terms.docx will be left out: Instagram sends PDF files only.',
    );
  });
});

describe('the reply window refusing a reply', () => {
  it('turns the strip closed, says the text was kept, and puts the text back', async () => {
    const { user, tickets } = await open(MOCK_TICKET_WHATSAPP);
    const conversation = MOCK_META_CONVERSATIONS[MOCK_TICKET_WHATSAPP];
    const closedAt = new Date(NOW.getTime()).toISOString();
    vi.spyOn(tickets, 'reply').mockRejectedValue(
      new MetaError('reply-window-closed', {
        platform: conversation?.platform ?? 'whatsapp',
        anchorAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        closedAt,
      }),
    );
    await strip();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Can we rebook?');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const refusal = await screen.findByText(/Not sent:/);
    expect(refusal.closest('[role="status"]')).toHaveTextContent(
      'Not sent: the window closed today at 10:31 while you were writing. Your text is kept below; it can go out once Daniel Reyes writes again.',
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Can we rebook?');
    // Nothing was written, so there is no bubble to retry.
    expect(within(thread()).queryByText('Not sent, retry')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send reply' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('a ticket of another channel', () => {
  it('draws nothing Meta', async () => {
    await open(MOCK_TICKET_REFUND, new MockMetaApi(), false);
    await screen.findByRole('form', { name: 'Reply or internal note' });

    expect(screen.queryByText(/Reply window/)).toBeNull();
    expect(screen.queryByRole('region', { name: /identity$/ })).toBeNull();
    expect(screen.queryByText(/Plain text\./)).toBeNull();
  });
});

describe('the Meta fixture', () => {
  it('keeps the thread and the strip agreeing about when the customer last wrote', async () => {
    const { tickets } = await open(MOCK_TICKET_WHATSAPP);
    const detail = await tickets.ticket('brand', MOCK_TICKET_WHATSAPP);
    const lastContact = [...detail.messages.messages]
      .reverse()
      .find(
        (message: TicketMessage) => message.authorType === 'contact' && message.kind === 'public',
      );

    expect(Date.parse(lastContact?.createdAt ?? '')).toBe(NOW.getTime() - 66 * 60 * 1000);
  });
});
