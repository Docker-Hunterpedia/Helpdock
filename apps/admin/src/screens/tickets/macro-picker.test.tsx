import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
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

  it('opens from "/" typed into an empty reply, and closes on Esc', async () => {
    const { user } = await openRefund();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), '/');
    expect(screen.getByRole('dialog', { name: /Insert a macro/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /Insert a macro/ })).not.toBeInTheDocument();
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
