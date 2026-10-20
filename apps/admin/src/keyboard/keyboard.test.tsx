import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { MOCK_STATUS_CLOSED, MOCK_TICKET_REFUND } from '../tickets/mock-api.js';
import { MockKeyboardApi } from './api.js';

/**
 * M14-01 in the app's real provider stack: the `?` sheet, the switch saved to
 * the account, `g` sequences, and the global, ticket and composer shortcuts
 * doing what the registry says. The rules themselves are `dispatch.test.ts`.
 */

/** Every media query answers yes: the 1440 px artboard, sidebar a column. */
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

beforeEach(wideViewport);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Role = 'admin' | 'viewer';

const renderAt = async (
  path: string,
  {
    role = 'admin',
    keyboardApi = new MockKeyboardApi(),
  }: { role?: Role; keyboardApi?: MockKeyboardApi } = {},
) => {
  const apis = await signedInMockApis();
  if (role === 'viewer') {
    const session = await apis.auth.me();
    vi.spyOn(apis.auth, 'me').mockResolvedValue(
      session === null
        ? null
        : { ...session, user: { ...session.user, role: 'viewer', installAdmin: false } },
    );
  }
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    keyboardApi,
    initialEntries: [path],
  });
  await screen.findByRole('navigation', { name: 'Main' });
  return rendered;
};

/** A key as the browser sends it from an Arabic layout: the letter it types, the key it is. */
const arabicPress = (key: string, code: string, shiftKey = false): void => {
  fireEvent.keyDown(document.body, { key, code, shiftKey });
};

const sheet = (): HTMLElement => screen.getByRole('dialog', { name: 'Keyboard shortcuts' });

describe('the ? sheet', () => {
  it('opens on ?, starts on its title, and lists the registry by group', async () => {
    const { user } = await renderAt('/tickets?view=all');

    await user.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByRole('heading', { name: 'Keyboard shortcuts' })).toHaveFocus();
    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['General', 'Go to', 'List', 'Ticket', 'Composer']);
    expect(within(dialog).getByText('Send and close')).toBeVisible();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    });
  });

  it('opens on the Arabic ؟ too', async () => {
    await renderAt('/contacts');

    arabicPress('؟', 'Slash', true);

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  it('offers a Viewer navigation only', async () => {
    const { user } = await renderAt('/tickets?view=all', { role: 'viewer' });

    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['General', 'Go to', 'List']);
    const terms = (group: string): (string | null)[] =>
      within(within(dialog).getByRole('region', { name: group }))
        .getAllByRole('term')
        .map((term) => term.textContent);
    expect(terms('General')).toEqual(['Search the list', 'Toggle the sidebar', 'All shortcuts']);
    expect(terms('Go to')).not.toContain('Settings');
    expect(terms('Go to')).toContain('Reports');
    expect(terms('List')).toEqual(['Next ticket', 'Previous ticket']);
  });
});

describe('the single-key switch', () => {
  it('turns every key without a modifier off, says so, and saves it to the account', async () => {
    const keyboardApi = new MockKeyboardApi();
    const { user } = await renderAt('/tickets?view=all', { keyboardApi });
    await screen.findByRole('link', { name: /HD-1042/ });

    await user.keyboard('?');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).getByRole(
        'switch',
        { name: 'Single-key shortcuts' },
      ),
    );

    expect(within(sheet()).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(within(sheet()).getByText(/Next ticket/).textContent).toContain('(off)');
    expect(within(sheet()).getByText(/^Send$/).textContent).not.toContain('(off)');
    await waitFor(async () => {
      expect(await keyboardApi.preferences()).toEqual({ singleKeyShortcuts: false });
    });

    await user.click(within(sheet()).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    });

    await user.keyboard('j');
    await user.keyboard('?');
    expect(screen.queryByRole('heading', { name: /Refund for order 42/ })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('starts from what the account says', async () => {
    const keyboardApi = new MockKeyboardApi();
    await keyboardApi.save({ singleKeyShortcuts: false });
    const { user } = await renderAt('/tickets?view=all', { keyboardApi });
    await screen.findByRole('link', { name: /HD-1042/ });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New ticket' })).not.toHaveAttribute(
        'aria-keyshortcuts',
      );
    });

    await user.keyboard('j');

    expect(screen.queryByRole('heading', { name: /Refund for order 42/ })).toBeNull();
  });

  it('goes back on, with a message, when the account cannot save it', async () => {
    const keyboardApi = new MockKeyboardApi();
    vi.spyOn(keyboardApi, 'save').mockRejectedValue(new Error('offline'));
    const { user } = await renderAt('/contacts', { keyboardApi });

    await user.keyboard('?');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).getByRole('switch'),
    );

    expect(await screen.findByText('The shortcut setting was not saved. Try again.')).toBeVisible();
    expect(within(sheet()).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('g sequences', () => {
  it('shows what can follow g, then opens the view of the second key', async () => {
    const { user } = await renderAt('/contacts');

    await user.keyboard('g');
    const chip = await screen.findByText(
      (_text, node) =>
        node?.getAttribute('role') === 'status' && (node.textContent ?? '').startsWith('g…'),
    );
    expect(chip.textContent).toContain('i My open');
    expect(chip.textContent).toContain('s Settings');

    await user.keyboard('i');

    expect(await screen.findByRole('heading', { level: 1, name: 'My open' })).toBeVisible();
    expect(chip.textContent).toBe('');
  });

  it('works on an Arabic layout, where g types ل and c types ؤ', async () => {
    await renderAt('/tickets?view=all');

    arabicPress('ل', 'KeyG');
    arabicPress('ؤ', 'KeyC');

    expect(await screen.findByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
  });
});

describe('the global shortcuts', () => {
  it('opens the new-ticket dialog with c from another page', async () => {
    const { user } = await renderAt('/contacts');

    await user.keyboard('c');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New ticket' })).toBeVisible();
  });

  it('puts the caret in the list’s search with /', async () => {
    const { user } = await renderAt('/tickets?view=all');
    await screen.findByRole('link', { name: /HD-1042/ });

    await user.keyboard('/');

    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: 'Search tickets' })).toHaveFocus();
    });
  });

  it('collapses the sidebar with b, as with ⌘\\', async () => {
    const { user } = await renderAt('/contacts');
    const toggle = screen.getByRole('button', { name: /Collapse sidebar|Expand sidebar/ });
    const before = toggle.getAttribute('aria-expanded');

    await user.keyboard('b');

    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).not.toBe(before);
    });
    expect(toggle).toHaveAttribute('aria-keyshortcuts', 'b Meta+\\ Control+\\');
  });
});

describe('the ticket shortcuts', () => {
  const openRefund = async () => {
    const rendered = await renderAt(`/tickets/${MOCK_TICKET_REFUND}?view=all`);
    await screen.findByRole('heading', { name: /Refund for order 42/ });
    return rendered;
  };

  it('opens the status menu with s, and the assignee picker with a', async () => {
    const { user } = await openRefund();

    await user.keyboard('s');
    expect(await screen.findByRole('option', { name: 'Awaiting customer' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: 'Awaiting customer' })).toBeNull();
    });

    await user.keyboard('a');
    expect(await screen.findByRole('listbox', { name: 'Assignee' })).toBeVisible();
  });

  it('closes the open ticket with e', async () => {
    const { user, ticketsApi } = await openRefund();

    await user.keyboard('e');

    await waitFor(async () => {
      const { ticket } = await ticketsApi.ticket('brand', MOCK_TICKET_REFUND);
      expect(ticket.status.id).toBe(MOCK_STATUS_CLOSED);
    });
  });

  it('sends with ⌘Enter from the composer, and sends and closes with ⌘⇧Enter', async () => {
    const { user, ticketsApi } = await openRefund();
    const body = screen.getByRole('textbox', { name: 'Message' });

    await user.click(body);
    await user.keyboard('First answer');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText('Reply sent')).toBeVisible();
    expect(body).toHaveValue('');

    await user.keyboard('Second answer');
    await user.keyboard('{Meta>}{Shift>}{Enter}{/Shift}{/Meta}');
    await waitFor(async () => {
      const { ticket } = await ticketsApi.ticket('brand', MOCK_TICKET_REFUND);
      expect(ticket.status.id).toBe(MOCK_STATUS_CLOSED);
    });
  });

  it('leaves ⌘Enter in the list’s search box alone', async () => {
    const { user, ticketsApi } = await openRefund();
    const reply = vi.spyOn(ticketsApi, 'reply');

    await user.click(screen.getByRole('searchbox', { name: 'Search tickets' }));
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(reply).not.toHaveBeenCalled();
  });
});
