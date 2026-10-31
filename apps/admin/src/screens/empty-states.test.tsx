import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';

/**
 * M14-23 (`Admin/Empty-States`): the first-run screens say what goes there and
 * offer the one action that fills them, and a screen still reading shows a
 * skeleton inside a busy region. Each case empties the one read the screen
 * makes, so what is asserted is the screen's decision, not the fixture's data.
 */

const BRAND = 'brand';

const NEVER = new Promise<never>(() => undefined);

const render = async (path: string) => {
  const apis = await signedInMockApis();
  const rendered = () =>
    renderApp(<AppRoutes />, {
      authApi: apis.auth,
      staffApi: apis.staff,
      contactsApi: apis.contacts,
      ticketingApi: apis.ticketing,
      ticketsApi: apis.tickets,
      automationApi: apis.automation,
      helpCenterApi: apis.helpCenter,
      initialEntries: [path],
    });

  return { apis, rendered };
};

const findEmptyState = async (heading: string): Promise<HTMLElement> => {
  const found = await screen.findByRole('heading', { name: heading });

  return found.parentElement as HTMLElement;
};

describe('Contacts', () => {
  const emptyContacts = async () => {
    const { apis, rendered } = await render('/contacts');
    const list = await apis.contacts.listContacts(BRAND);
    vi.spyOn(apis.contacts, 'listContacts').mockResolvedValue({
      ...list,
      contacts: [],
      total: 0,
      duplicateCount: 0,
      nextCursor: null,
    });

    return { apis, ...rendered() };
  };

  it('offers Add contact when the brand has nobody, and the button opens the new-contact page', async () => {
    const { user } = await emptyContacts();

    const state = await findEmptyState('No contacts yet');
    expect(within(state).getByText(/People appear here when they write in/)).toBeInTheDocument();
    await user.click(within(state).getByRole('button', { name: 'Add contact' }));

    expect(await screen.findByRole('dialog', { name: 'New contact' })).toBeInTheDocument();
  });

  it('keeps the no-match sentence, without the action, when a search finds nobody', async () => {
    const { user } = await emptyContacts();
    await screen.findByRole('heading', { name: 'No contacts yet' });
    await user.type(screen.getByRole('textbox', { name: /Name, email/ }), 'zzz');

    expect(await screen.findByText('Nothing matches that search')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add contact' })).not.toBeInTheDocument();
  });

  it('draws a busy skeleton while the list is out', async () => {
    const { apis, rendered } = await render('/contacts');
    vi.spyOn(apis.contacts, 'listContacts').mockReturnValue(NEVER);
    rendered();

    const region = await screen.findByRole('status', { name: 'Loading contacts' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers New account on the Accounts tab and opens the account dialog', async () => {
    const { apis, rendered } = await render('/contacts?tab=accounts');
    const accounts = await apis.contacts.listAccounts(BRAND);
    vi.spyOn(apis.contacts, 'listAccounts').mockResolvedValue({
      ...accounts,
      accounts: [],
      total: 0,
    });
    const { user } = rendered();

    const state = await findEmptyState('No accounts yet');
    await user.click(within(state).getByRole('button', { name: 'New account' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('Help center', () => {
  it('starts with a category when there is none, and the button opens the naming dialog', async () => {
    const { apis, rendered } = await render('/help-center');
    const structure = await apis.helpCenter.structure(BRAND);
    vi.spyOn(apis.helpCenter, 'structure').mockResolvedValue({
      ...structure,
      categories: [],
      sections: [],
      articles: [],
    });
    const { user } = rendered();

    await screen.findByRole('heading', { name: 'Start your help center' });
    await user.click(screen.getByRole('button', { name: 'New category' }));

    expect(await screen.findByRole('dialog', { name: 'New category' })).toBeInTheDocument();
  });

  it('names the section that has no article and offers New article', async () => {
    const { apis, rendered } = await render('/help-center');
    const structure = await apis.helpCenter.structure(BRAND);
    vi.spyOn(apis.helpCenter, 'structure').mockResolvedValue({ ...structure, articles: [] });
    rendered();

    const state = await findEmptyState('No articles yet');
    expect(within(state).getByRole('button', { name: 'New article' })).toBeEnabled();
  });
});

describe('Views', () => {
  it('offers New view when nothing is saved, and the button opens the editor', async () => {
    const { apis, rendered } = await render('/settings/inbox/views');
    const views = await apis.tickets.views(BRAND);
    vi.spyOn(apis.tickets, 'views').mockResolvedValue({ ...views, views: [] });
    const { user } = rendered();

    await screen.findByRole('heading', { name: 'No saved views' });
    await user.click(screen.getByRole('button', { name: 'New view' }));

    expect(
      await screen.findByRole('heading', { name: /New view|Create view/ }),
    ).toBeInTheDocument();
  });

  it('draws a busy skeleton while the views are out', async () => {
    const { apis, rendered } = await render('/settings/inbox/views');
    vi.spyOn(apis.tickets, 'views').mockReturnValue(NEVER);
    rendered();

    const region = await screen.findByRole('status', { name: 'Loading views' });
    expect(region).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Macros and saved replies', () => {
  it('offers New saved reply when there are none, and it opens a canned response', async () => {
    const { apis, rendered } = await render('/settings/inbox/macros');
    const macros = await apis.ticketing.macros(BRAND);
    vi.spyOn(apis.ticketing, 'macros').mockResolvedValue({ ...macros, macros: [] });
    const { user } = rendered();

    await screen.findByRole('heading', { name: 'No saved replies yet' });
    await user.click(screen.getByRole('button', { name: 'New saved reply' }));

    await waitFor(() => {
      expect(screen.getByRole('form')).toBeInTheDocument();
    });
  });
});

describe('Rules', () => {
  it('offers New rule for the event rules, linking to the builder for that kind', async () => {
    const { apis, rendered } = await render('/settings/inbox/rules');
    vi.spyOn(apis.automation, 'rules').mockResolvedValue({ rules: [] });
    rendered();

    const state = await findEmptyState('No rules yet');
    expect(within(state).getByRole('link', { name: 'New rule' })).toHaveAttribute(
      'href',
      expect.stringContaining('/rules/new?kind=event'),
    );
  });

  it('draws a busy skeleton while the rules are out', async () => {
    const { apis, rendered } = await render('/settings/inbox/rules');
    vi.spyOn(apis.automation, 'rules').mockReturnValue(NEVER);
    rendered();

    const region = await screen.findByRole('status', { name: 'Loading rules' });
    expect(region).toHaveAttribute('aria-busy', 'true');
  });
});
