import type { Session } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import type { MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { SIDEBAR_STORAGE_KEY } from './sidebar-collapse.js';

/**
 * The Admin group is one Settings entry (M14-21): everything it held is in the
 * Settings area's own navigation, which `settings-shell.test.tsx` covers by
 * role. The sidebar keeps Reports' role rule, which is not a setting.
 */

/** `renderApp` names the pair as props; `signedInMockApis` names them as the app does. */
const asProps = ({ auth, staff }: AdminApis) => ({ authApi: auth, staffApi: staff });

/** The fixture's session with a field changed, which it cannot change itself. */
const withUser = async (changes: Partial<Session['user']>): Promise<AdminApis> => {
  const apis = await signedInMockApis();
  const session = await apis.auth.me();
  if (session === null) {
    throw new Error('expected a session');
  }

  const changed: Session = { ...session, user: { ...session.user, ...changes } };
  (apis.auth as MockAuthApi).me = async () => changed;

  return apis;
};

const navLinks = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');

describe('the admin nav', () => {
  it.each([
    { role: 'admin', installAdmin: true },
    { role: 'admin', installAdmin: false },
    { role: 'teamLeader', installAdmin: false },
    { role: 'agent', installAdmin: false },
    { role: 'viewer', installAdmin: false },
  ] as const)('has one Settings entry and no Admin group for $role', async (user) => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser(user)),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).toContain('Settings');
    for (const moved of ['System', 'Staff and roles', 'Developers', 'Brand', 'Ticketing']) {
      expect(navLinks()).not.toContain(moved);
    }
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('opens the branch of the current page by itself and marks that page current', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/settings/inbox/slas'],
    });
    await screen.findByRole('navigation', { name: 'Main' });
    const nav = screen.getByRole('navigation', { name: 'Main' });

    expect(within(nav).getByRole('button', { name: 'Pages of Settings' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(nav).getByRole('button', { name: 'Inbox' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(nav).getByRole('button', { name: 'Brand' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav).getByRole('link', { name: 'SLA policies' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens one Settings group at a time, and a group row only expands', async () => {
    const { user } = renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/settings/inbox/slas'],
    });
    await screen.findByRole('navigation', { name: 'Main' });
    const nav = screen.getByRole('navigation', { name: 'Main' });

    await user.click(within(nav).getByRole('button', { name: 'Brand' }));

    expect(within(nav).getByRole('button', { name: 'Brand' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(nav).getByRole('button', { name: 'Inbox' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // A second click does not fold it.
    await user.click(within(nav).getByRole('button', { name: 'Brand' }));
    expect(within(nav).getByRole('button', { name: 'Brand' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(nav).getByRole('link', { name: 'Data retention' })).toBeVisible();
  });

  it('opens one section at a time: the row of a closed section goes to its first page, the row of the current one folds it', async () => {
    const { user } = renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: 'Pages of Tickets' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await user.click(within(nav).getByRole('link', { name: 'Contacts' }));
    await waitFor(() => {
      expect(within(nav).getByRole('link', { name: 'People' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
    expect(within(nav).getByRole('button', { name: 'Pages of Tickets' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await user.click(within(nav).getByRole('link', { name: 'Contacts' }));
    expect(within(nav).getByRole('button', { name: 'Pages of Contacts' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Folding did not navigate.
    expect(within(nav).getByRole('link', { name: 'People', hidden: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens another section by hand with its chevron', async () => {
    const { user } = renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });
    const nav = screen.getByRole('navigation', { name: 'Main' });

    await user.click(within(nav).getByRole('button', { name: 'Pages of Help center' }));

    expect(within(nav).getByRole('link', { name: 'Articles' })).toBeVisible();
    expect(within(nav).getByRole('button', { name: 'Pages of Tickets' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('gives Reports no chevron, and Accounts its own page', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/contacts/accounts'],
    });
    await screen.findByRole('navigation', { name: 'Main' });
    const nav = screen.getByRole('navigation', { name: 'Main' });

    expect(within(nav).queryByRole('button', { name: 'Pages of Reports' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Accounts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'People' })).not.toHaveAttribute('aria-current');
  });

  /** M8-04: `report:read` is an Admin's, a Team Leader's and a Viewer's, not an Agent's. */
  it.each([
    ['admin', true],
    ['teamLeader', true],
    ['viewer', true],
    ['agent', false],
  ] as const)('offers Reports to %s: %s', async (role, offered) => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser({ role, installAdmin: false })),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks().some((link) => link.startsWith('Reports'))).toBe(offered);
  });
});

describe('collapsing the sidebar (Admin/Shell-SidebarCollapse)', () => {
  const renderWithCounts = async () => {
    const apis = await signedInMockApis();
    const session = await apis.auth.me();
    vi.spyOn(apis.auth, 'me').mockResolvedValue(
      session === null ? null : { ...session, navCounts: { tickets: 38 } },
    );
    const rendered = renderApp(<AppRoutes />, { ...asProps(apis), initialEntries: ['/tickets'] });
    await screen.findByRole('navigation', { name: 'Main' });

    return rendered;
  };

  it('folds to a rail of named icons, keeps focus on the toggle and remembers it', async () => {
    const { user } = await renderWithCounts();
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(collapse.getAttribute('aria-controls') ?? '')).not.toBeNull();

    await user.click(collapse);

    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toBe(collapse);
    expect(expand).toHaveFocus();
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: 'Tickets · 38' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Contacts' })).toHaveTextContent('');
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
  });

  it('opens the views from the rail in a popover', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    const { user } = await renderWithCounts();

    await user.click(screen.getByRole('button', { name: 'Tickets · 38' }));

    const views = await screen.findByRole('dialog', { name: 'Views' });
    expect(await within(views).findByRole('link', { name: /^All tickets/ })).toBeInTheDocument();
  });

  it('opens a flyout with the same pages from the rail, and closes it on a choice', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    const { user } = await renderWithCounts();

    await user.click(screen.getByRole('button', { name: 'Contacts' }));
    const menu = await screen.findByRole('menu', { name: 'Contacts' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Accounts' }));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', {
        name: 'Contacts',
      }),
    ).toBeInTheDocument();
  });

  it('opens the Settings flyout with its groups and closes it on Escape', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    const { user } = await renderWithCounts();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const menu = await screen.findByRole('menu', { name: 'Settings' });
    expect(within(menu).getByRole('menuitem', { name: 'Statuses' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
