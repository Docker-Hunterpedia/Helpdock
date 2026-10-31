import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_SINGLE_KEY_STORAGE } from '../../auth/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND } from '../../tickets/mock-api.js';

/**
 * The composer's macro picker (M3-06, artboard `AdminComposerMacros`) against
 * the fixtures: what it offers on a Support ticket, what it fills in, what it
 * stages, and what one send then does.
 */

const openRefund = async () => {
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
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    initialEntries: [`/tickets/${MOCK_TICKET_REFUND}?view=all`],
  });
  await screen.findByRole('heading', { name: /Refund for order 42/ });

  return { ...rendered, apis };
};

const openPicker = async (user: Awaited<ReturnType<typeof openRefund>>['user']) => {
  await user.click(screen.getByRole('button', { name: 'Macros and canned' }));

  return screen.getByRole('dialog', { name: 'Insert a macro or canned response' });
};

describe('the macro picker', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers what is shared with the ticket’s department, with every one, or is the reader’s', async () => {
    const { user } = await openRefund();
    const picker = await openPicker(user);

    const options = await within(picker).findAllByRole('option');
    const names = options.map((option) => option.textContent ?? '');
    expect(names.some((name) => name.startsWith('Shipping fees explained'))).toBe(true);
    expect(names.some((name) => name.startsWith('My follow-up line'))).toBe(true);
    // Shared with Billing only; this ticket is Support's.
    expect(names.some((name) => name.startsWith('Refund issued'))).toBe(false);
  });

  it('lists the saved replies after "/" typed into an empty reply, and closes on Esc (M14-14)', async () => {
    const { user } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, '/');
    expect(
      await screen.findByRole('listbox', { name: 'Saved replies and macros' }),
    ).toBeInTheDocument();
    // The slash is the person's text until they choose something.
    expect(body).toHaveValue('/');

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('listbox', { name: 'Saved replies and macros' }),
    ).not.toBeInTheDocument();
    expect(body).toHaveValue('/');
  });

  it('completes /shipping with Tab, in the middle of a reply (M14-14)', async () => {
    const { user } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, 'Hi Mona, /shipp');
    const list = await screen.findByRole('listbox', { name: 'Saved replies and macros' });
    const options = await within(list).findAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Shipping fees explained');
    expect(options[0]).toHaveTextContent('/shipping');
    expect(body).toHaveAttribute('aria-activedescendant', options[0]?.id);

    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(body).toHaveValue(
        'Hi Mona, Hi Mona, the charge you saw at delivery is the carrier’s customs fee, not a shipping fee from us.',
      );
    });
    expect(
      screen.queryByRole('listbox', { name: 'Saved replies and macros' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Staged by macro Shipping fees explained' }),
    ).toBeInTheDocument();
  });

  it('inserts with Enter and lets the arrows pick another (M14-14)', async () => {
    const { user } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, '/');
    const list = await screen.findByRole('listbox', { name: 'Saved replies and macros' });
    const options = await within(list).findAllByRole('option');
    // Yours first, then the brand's by recent use.
    expect(options[0]).toHaveTextContent('My follow-up line');
    expect(options[1]).toHaveTextContent('Shipping fees explained');

    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}{Enter}');

    await waitFor(() => {
      expect(body).toHaveValue('I will check back with you tomorrow.');
    });
  });

  it('leaves a slash inside a word or a URL alone (M14-14)', async () => {
    const { user } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, 'see https://example.com/shipping and a/b');

    expect(
      screen.queryByRole('listbox', { name: 'Saved replies and macros' }),
    ).not.toBeInTheDocument();
  });

  it('says so when nothing answers to the shortcut, and Enter stays a new line (M14-14)', async () => {
    const { user } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, '/zzz');
    expect(await screen.findByText('No saved reply or macro matches that.')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(body).toHaveValue('/zzz\n');
  });

  it('does not open on "/" while single-key shortcuts are off, but {{ still works (M14-14)', async () => {
    localStorage.setItem(MOCK_SINGLE_KEY_STORAGE, 'off');
    try {
      const { user } = await openRefund();
      const body = screen.getByRole('textbox', { name: 'Message' });

      await user.type(body, '/shipp');
      expect(
        screen.queryByRole('listbox', { name: 'Saved replies and macros' }),
      ).not.toBeInTheDocument();

      await user.clear(body);
      await user.type(body, '{{{{');
      expect(await screen.findByRole('listbox', { name: 'Placeholders' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem(MOCK_SINGLE_KEY_STORAGE);
    }
  });

  it('lists who can see the ticket after @ in a note, and writes the handle (M14-15)', async () => {
    const { user } = await openRefund();
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, 'Can you check? @om');
    const list = await screen.findByRole('listbox', { name: 'People who can see this ticket' });
    // The query is sent after a short pause, so the list narrows a moment later.
    await waitFor(() => {
      expect(within(list).getAllByRole('option')).toHaveLength(1);
    });
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Omar Nasser');
    expect(options[0]).toHaveTextContent('@omar.nasser');
    expect(options[0]).toHaveTextContent('Online');
    expect(body).toHaveAttribute('aria-activedescendant', options[0]?.id);

    await user.keyboard('{Enter}');

    expect(body).toHaveValue('Can you check? @omar.nasser ');
    expect(
      screen.queryByRole('listbox', { name: 'People who can see this ticket' }),
    ).not.toBeInTheDocument();
  });

  it('says so when nobody matches, and Esc keeps what was typed (M14-15)', async () => {
    const { user } = await openRefund();
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, '@zzz');
    expect(await screen.findByText('No one who can see this ticket matches.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('listbox', { name: 'People who can see this ticket' }),
    ).not.toBeInTheDocument();
    expect(body).toHaveValue('@zzz');
  });

  it('finds a colleague typed in Arabic (M14-15)', async () => {
    const { user } = await openRefund();
    await user.click(screen.getByRole('button', { name: 'Internal note' }));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), '@عمر');

    const list = await screen.findByRole('listbox', { name: 'People who can see this ticket' });
    await waitFor(() => {
      expect(within(list).getAllByRole('option')).toHaveLength(1);
    });
    expect(within(list).getByRole('option')).toHaveTextContent('Omar Nasser');
  });

  it('shows the card while loading, and keeps Enter from becoming a new line (M14-15)', async () => {
    const { user, apis } = await openRefund();
    vi.spyOn(apis.tickets, 'mentionCandidates').mockImplementation(() => new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, '@om');
    const list = await screen.findByRole('listbox', { name: 'People who can see this ticket' });
    expect(within(list).getByText('Loading people')).toBeInTheDocument();
    expect(body).toHaveAttribute('aria-controls', list.id);

    await user.keyboard('{Enter}');
    expect(body).toHaveValue('@om');
  });

  it('says so when the people cannot be loaded, and tries again on request (M14-15)', async () => {
    const { user, apis } = await openRefund();
    const real = apis.tickets.mentionCandidates.bind(apis.tickets);
    vi.spyOn(apis.tickets, 'mentionCandidates')
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(real);
    await user.click(screen.getByRole('button', { name: 'Internal note' }));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), '@om');
    expect(await screen.findByRole('alert')).toHaveTextContent("People couldn't be loaded.");
    // A failure is not "nobody matches".
    expect(screen.queryByText('No one who can see this ticket matches.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: /Omar Nasser/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not offer people in a public reply or inside an email address (M14-15)', async () => {
    const { user } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });
    await user.type(body, 'ask @om');
    expect(
      screen.queryByRole('listbox', { name: 'People who can see this ticket' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    await user.clear(body);
    await user.type(body, 'write to lina@om');
    expect(
      screen.queryByRole('listbox', { name: 'People who can see this ticket' }),
    ).not.toBeInTheDocument();
  });

  it('does not offer saved replies in a note (M14-14)', async () => {
    const { user } = await openRefund();
    await user.click(screen.getByRole('button', { name: 'Internal note' }));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), '/shipp');

    expect(
      screen.queryByRole('listbox', { name: 'Saved replies and macros' }),
    ).not.toBeInTheDocument();
  });

  it('opens the placeholder list on {{ and inserts the value for this ticket (M14-14)', async () => {
    const { user } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.type(body, 'Hello {{{{');
    const list = await screen.findByRole('listbox', { name: 'Placeholders' });
    expect(within(list).getByText('Mona', { selector: 'bdi' })).toBeInTheDocument();
    // Only what this ticket can answer is offered; the sender's title is not known here.
    expect(within(list).queryByText('{{agent.title}}')).not.toBeInTheDocument();

    await user.click(within(list).getByRole('option', { name: /contact\.first_name/ }));

    expect(body).toHaveValue('Hello Mona');
  });

  it('previews the filled-in reply with placeholders marked, and the actions it will run', async () => {
    const { user } = await openRefund();
    const picker = await openPicker(user);

    await user.type(within(picker).getByRole('combobox', { name: /Search macros/ }), 'duplicate');

    expect(await within(picker).findByText('Mona', { selector: 'bdi' })).toBeInTheDocument();
    expect(within(picker).getByText('When you send the reply')).toBeInTheDocument();
    expect(within(picker).getByText(/Status Open → Closed/)).toBeInTheDocument();
  });

  it('fills the composer, stages the actions as removable chips, and sends them with the reply', async () => {
    const { user, apis } = await openRefund();
    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox', { name: /Search macros/ }), 'duplicate');
    await within(picker).findByText('Mona', { selector: 'bdi' });

    await user.click(within(picker).getByRole('button', { name: 'Apply macro' }));

    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
      'Hi Mona, we are following this up on your other ticket.',
    );
    const staged = screen.getByRole('group', { name: 'Staged by macro Close as duplicate' });
    await user.click(within(staged).getByRole('button', { name: /Remove: Tag − Bug/ }));
    expect(within(staged).queryByText(/Tag − Bug/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send email' }));

    await waitFor(async () => {
      const { ticket } = await apis.tickets.ticket('brand', MOCK_TICKET_REFUND);
      expect(ticket.status.name).toBe('Closed');
    });
    const { activity } = await apis.tickets.activity('brand', MOCK_TICKET_REFUND);
    expect(activity.at(-1)).toMatchObject({
      action: 'ticket.macro_applied',
      to: { macroName: 'Close as duplicate' },
    });
    expect(screen.queryByRole('group', { name: /Staged by macro/ })).not.toBeInTheDocument();
  });

  it('switches the variant, and says when the one asked for is empty', async () => {
    const { user } = await openRefund();
    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox', { name: /Search macros/ }), 'follow-up');
    await within(picker).findByText('English variant');

    await user.click(within(picker).getByRole('button', { name: 'Use Arabic' }));

    expect(
      await within(picker).findByText('The Arabic variant is empty, so English is used'),
    ).toBeInTheDocument();
  });
});
