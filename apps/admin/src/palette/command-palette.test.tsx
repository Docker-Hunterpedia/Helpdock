import type { QuickSearch } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { AuthError } from '../auth/api.js';
import { MockAuthApi } from '../auth/mock-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { MOCK_TICKET_REFUND } from '../tickets/mock-api.js';
import { MockQuickSearchApi, type QuickSearchApi } from './api.js';
import { readRecents, recentsKey, remember } from './recents.js';

/**
 * M14-05 in the app's real provider stack: the palette opens on ⌘K, finds by
 * reference and by Arabic setting name, offers the actions of the screen and
 * the person, remembers ids only, and says so when a section fails. The pure
 * rules are `model.test.ts`, `fold.test.ts` and `pages.test.ts`.
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

beforeEach(() => {
  wideViewport();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Where(): null {
  const { pathname, search } = useLocation();
  document.body.dataset.where = `${pathname}${search}`;
  return null;
}
const where = (): string => document.body.dataset.where ?? '';

interface Options {
  readonly role?: 'admin' | 'viewer';
  readonly singleKeys?: boolean;
  readonly quickSearch?: (real: QuickSearchApi) => QuickSearchApi;
}

const renderAt = async (
  path: string,
  { role = 'admin', singleKeys, quickSearch }: Options = {},
) => {
  const apis = await signedInMockApis();
  if (singleKeys !== undefined && apis.auth instanceof MockAuthApi) {
    apis.auth.saveSingleKeyShortcuts(singleKeys);
  }
  if (role === 'viewer') {
    const session = await apis.auth.me();
    vi.spyOn(apis.auth, 'me').mockResolvedValue(
      session === null
        ? null
        : { ...session, user: { ...session.user, role: 'viewer', installAdmin: false } },
    );
  }
  const real = new MockQuickSearchApi(
    { tickets: apis.tickets, contacts: apis.contacts, helpCenter: apis.helpCenter },
    () => role,
  );
  const rendered = renderApp(
    <>
      <AppRoutes />
      <Where />
    </>,
    {
      authApi: apis.auth,
      staffApi: apis.staff,
      contactsApi: apis.contacts,
      ticketingApi: apis.ticketing,
      ticketsApi: apis.tickets,
      uploader: apis.uploader,
      helpCenterApi: apis.helpCenter,
      quickSearchApi: quickSearch === undefined ? real : quickSearch(real),
      initialEntries: [path],
    },
  );
  await screen.findByRole('navigation', { name: 'Main' });
  return { ...rendered, real, session: await apis.auth.me() };
};

const palette = (): HTMLElement => screen.getByRole('dialog', { name: 'Command palette' });
const input = (): HTMLElement => within(palette()).getByRole('combobox');

const optionNames = (): string[] =>
  within(palette())
    .queryAllByRole('option')
    .map((option) => option.textContent ?? '');

describe('opening and closing', () => {
  it('opens on Ctrl+K with the combobox focused, and Esc gives focus back', async () => {
    const { user } = await renderAt('/contacts');
    const opener = await screen.findByRole('button', { name: /Lina Haddad/ });
    opener.focus();

    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeVisible();
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('aria-autocomplete', 'list');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    });
    expect(opener).toHaveFocus();
  });

  it('opens from the sidebar’s Search, which shows the key', async () => {
    const { user } = await renderAt('/contacts');

    const button = await screen.findByRole('button', { name: 'Search' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+k Control+k');
    await user.click(button);

    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeVisible();
  });

  it('closes on Ctrl+K pressed inside it', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.keyboard('{Control>}k{/Control}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    });
  });
});

describe('the empty palette', () => {
  it('offers the actions of the screen, with their keys', async () => {
    const { user } = await renderAt('/tickets?view=all');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await waitFor(() => {
      expect(optionNames()).toEqual(expect.arrayContaining(['New ticketc', 'Keyboard shortcuts?']));
    });
  });

  it('draws no single-key cap while the switch is off', async () => {
    const { user } = await renderAt('/tickets?view=all', { singleKeys: false });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await waitFor(() => {
      expect(optionNames()).toContain('New ticket');
    });
    expect(optionNames()).toContain('Keyboard shortcuts');
    expect(optionNames().some((name) => name.endsWith('c'))).toBe(false);
  });

  it('lists recent tickets, contacts and settings pages, re-read through the api', async () => {
    const { user, session } = await renderAt('/tickets?view=all');
    const userId = session?.user.id ?? '';
    const brandId = session?.currentBrandId ?? '';
    remember(userId, brandId, { kind: 'page', id: 'ticketingSlas' });
    remember(userId, brandId, { kind: 'ticket', id: MOCK_TICKET_REFUND });

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    const group = await within(palette()).findByRole('group', { name: 'Recent' });
    expect(
      within(group)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['HD-1042Refund for order 42 has not arrived', 'Inbox › SLA policies']);
  });

  it.each([403, 404])('drops a recent the api answers %i for, and forgets it', async (status) => {
    const { user, session, ticketsApi } = await renderAt('/tickets?view=all');
    const userId = session?.user.id ?? '';
    const brandId = session?.currentBrandId ?? '';
    remember(userId, brandId, { kind: 'ticket', id: MOCK_TICKET_REFUND });
    remember(userId, brandId, { kind: 'ticket', id: 'a-ticket-that-is-gone' });
    const real = ticketsApi.ticket.bind(ticketsApi);
    vi.spyOn(ticketsApi, 'ticket').mockImplementation((brand, id) =>
      id === 'a-ticket-that-is-gone'
        ? Promise.reject(new AuthError('unavailable', { status }))
        : real(brand, id),
    );

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await within(palette()).findByRole('group', { name: 'Recent' });
    expect(optionNames().filter((name) => name.startsWith('HD-'))).toHaveLength(1);
    await waitFor(() => {
      expect(readRecents(userId, brandId)).toEqual([{ kind: 'ticket', id: MOCK_TICKET_REFUND }]);
    });
  });

  it.each([500, 429])('keeps a recent when the api answers %i', async (status) => {
    const { user, session, ticketsApi } = await renderAt('/tickets?view=all');
    const userId = session?.user.id ?? '';
    const brandId = session?.currentBrandId ?? '';
    remember(userId, brandId, { kind: 'ticket', id: MOCK_TICKET_REFUND });
    vi.spyOn(ticketsApi, 'ticket').mockRejectedValue(new AuthError('unavailable', { status }));

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await waitFor(() => {
      expect(within(palette()).queryByRole('group', { name: 'Recent' })).toBeNull();
    });
    expect(readRecents(userId, brandId)).toEqual([{ kind: 'ticket', id: MOCK_TICKET_REFUND }]);
  });

  it('records a visit as ids only, never a title', async () => {
    const { session } = await renderAt(`/tickets/${MOCK_TICKET_REFUND}`);

    await waitFor(() => {
      expect(
        localStorage.getItem(recentsKey(session?.user.id ?? '', session?.currentBrandId ?? '')),
      ).toBe(JSON.stringify([{ kind: 'ticket', id: MOCK_TICKET_REFUND }]));
    });
  });
});

describe('typing', () => {
  it('words an exact reference as “Open HD-1042” and Enter opens it', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), '1042');

    const first = await within(palette()).findByRole('option', { name: /Open .*HD-1042/ });
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', first.id);

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(where()).toBe(`/tickets/${MOCK_TICKET_REFUND}`);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    });
  });

  it('moves the active option with the arrows and wraps', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(input(), 'invoice');
    await within(palette()).findAllByRole('option', { name: /HD-/ });
    await waitFor(() => {
      expect(within(palette()).getAllByRole('option').length).toBeGreaterThan(2);
    });
    const options = within(palette()).getAllByRole('option');

    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', options[1]?.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');
  });

  it('finds a settings page by an Arabic keyword whatever the interface language', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'اتفاقيه مستوي');

    const group = await within(palette()).findByRole('group', { name: 'Go to' });
    expect(within(group).getAllByRole('option')[0]).toHaveTextContent('Inbox › SLA policies');

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(where()).toBe('/settings/inbox/slas');
    });
  });

  it('finds an English keyword for a page', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'working hours');

    await waitFor(() => {
      expect(optionNames()).toContain('Inbox › Business hours');
    });
  });

  it('announces the count politely and offers every ticket matching', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'invoice');

    await waitFor(() => {
      expect(within(palette()).getByRole('status')).toHaveTextContent(/\d+ results?/);
    });
    await user.click(within(palette()).getByRole('option', { name: /See all tickets matching/ }));
    await waitFor(() => {
      expect(where()).toBe('/tickets?q=invoice');
    });
  });

  it('says so when nothing matches, and offers the ticket search', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'zzqqxx');

    expect(await within(palette()).findByText(/Nothing matches/, { selector: 'p' })).toBeVisible();
    expect(within(palette()).queryByRole('listbox')).toBeNull();
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(palette()).getByRole('button', { name: 'Search all tickets' }));
    await waitFor(() => {
      expect(where()).toBe('/tickets?q=zzqqxx');
    });
  });
});

describe('the actions', () => {
  it('offers a ticket actions only while one is open, and runs one after closing', async () => {
    const { user } = await renderAt(`/tickets/${MOCK_TICKET_REFUND}`);
    await screen.findByRole('textbox', { name: /reply/i }).catch(() => null);
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'priority');
    const option = await within(palette()).findByRole('option', { name: /Change priority/ });
    await user.click(option);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    });
    expect(await screen.findByRole('listbox', { name: /priority/i })).toBeVisible();
  });

  it('opens the macro picker from "Apply a macro", now that the header has no Macro button (UX-21)', async () => {
    const { user } = await renderAt(`/tickets/${MOCK_TICKET_REFUND}`);
    await screen.findByRole('heading', { name: /Refund for order 42/ });
    expect(screen.queryByRole('button', { name: 'Macro' })).toBeNull();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(input(), 'macro');
    await user.click(await within(palette()).findByRole('option', { name: /Apply a macro/ }));

    expect(
      await screen.findByRole('dialog', { name: 'Insert a macro or canned response' }),
    ).toBeVisible();
  });

  it('does not offer ticket actions on another screen', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'priority');

    await waitFor(() => {
      expect(within(palette()).queryByRole('option', { name: /Change priority/ })).toBeNull();
    });
  });

  it('switches the interface language', async () => {
    const { user } = await renderAt('/contacts');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'switch to');
    await user.click(await within(palette()).findByRole('option', { name: /العربية/ }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ar');
    });
  });

  it('gives a Viewer navigation only, and says the rest is not listed', async () => {
    const { user } = await renderAt('/tickets?view=all', { role: 'viewer' });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'new ticket');

    await waitFor(() => {
      expect(within(palette()).getByText("Actions you can't take aren't listed.")).toBeVisible();
    });
    expect(within(palette()).queryByRole('option', { name: /^New ticket/ })).toBeNull();
  });
});

describe('when something goes wrong', () => {
  it('replaces a failed section with a notice and a retry, and keeps the others', async () => {
    const { user, real } = await renderAt('/contacts');
    real.failSection('articles');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'invoice');

    const notice = await within(palette()).findByText(
      "Articles couldn't load. Other results are complete.",
    );
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(optionNames().some((name) => name.includes('HD-'))).toBe(true);

    real.failSection('articles', false);
    await user.click(within(palette()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(within(palette()).queryByText(/couldn't load/)).toBeNull();
    });
  });

  it('keeps pages and actions when the whole search fails', async () => {
    const { user } = await renderAt('/contacts', {
      quickSearch: () => ({
        search: async () => {
          throw new Error('offline');
        },
      }),
    });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'macros');

    expect(
      await within(palette()).findByText("Search couldn't load. Pages and actions still work."),
    ).toBeVisible();
    expect(optionNames()).toContain('Inbox › Macros');
  });
});

describe('the search request', () => {
  it('waits for typing to settle, and cancels what the next key makes stale', async () => {
    const calls: { q: string; signal: AbortSignal | undefined }[] = [];
    const never: QuickSearch = {
      tickets: { status: 'ok', items: [] },
      contacts: { status: 'ok', items: [] },
      articles: { status: 'ok', items: [] },
    };
    const { user } = await renderAt('/contacts', {
      quickSearch: () => ({
        search: (_brand, { q }, signal) => {
          calls.push({ q, signal });
          return new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason);
            });
            setTimeout(() => {
              resolve(never);
            }, 400);
          });
        },
      }),
    });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    await user.type(input(), 'abc');
    await waitFor(() => {
      expect(calls.map((call) => call.q)).toEqual(['abc']);
    });
    await user.type(input(), 'd');
    await waitFor(() => {
      expect(calls.map((call) => call.q)).toEqual(['abc', 'abcd']);
    });
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);
  });

  it('sends nothing for an empty query', async () => {
    const search = vi.fn<QuickSearchApi['search']>();
    const { user } = await renderAt('/contacts', { quickSearch: () => ({ search }) });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(input(), '   ');

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(search).not.toHaveBeenCalled();
  });
});
