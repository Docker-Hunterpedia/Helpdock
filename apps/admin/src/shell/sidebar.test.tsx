import type { Session } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import type { MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { SIDEBAR_STORAGE_KEY } from './sidebar-collapse.js';
import { viewsCollapseKey } from './views-collapse.js';

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

  it('keeps Settings current on every page of the area', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/settings/inbox/slas'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Settings',
      }),
    ).toHaveAttribute('aria-current', 'page');
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
    expect(within(nav).getByRole('link', { name: 'Tickets · 38' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Contacts' })).toHaveTextContent('');
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
  });

  it('opens the views from the rail in a popover', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    const { user } = await renderWithCounts();

    await user.click(screen.getByRole('button', { name: 'Views' }));

    const views = await screen.findByRole('dialog', { name: 'Views' });
    expect(await within(views).findByRole('link', { name: /^All tickets/ })).toBeInTheDocument();
  });
});

describe('folding the Views group (M14-21)', () => {
  const renderTickets = async () => {
    const apis = await signedInMockApis();
    const session = await apis.auth.me();
    const rendered = renderApp(<AppRoutes />, { ...asProps(apis), initialEntries: ['/tickets'] });
    await screen.findByRole('navigation', { name: 'Main' });

    return { ...rendered, userId: session?.user.id ?? '' };
  };

  it('folds under its label, remembers it for the person and opens again', async () => {
    const { user, userId } = await renderTickets();
    const toggle = await screen.findByRole('button', { name: 'Views', expanded: true });
    expect(await screen.findByRole('link', { name: /^All tickets/ })).toBeVisible();

    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'Views', expanded: false })).toBe(toggle);
    expect(screen.queryByRole('link', { name: /^All tickets/ })).toBeNull();
    expect(localStorage.getItem(viewsCollapseKey(userId))).toBe('collapsed');

    await user.click(toggle);

    expect(await screen.findByRole('link', { name: /^All tickets/ })).toBeVisible();
    expect(localStorage.getItem(viewsCollapseKey(userId))).toBe('open');
  });

  it('comes back folded for the person who left it folded', async () => {
    const apis = await signedInMockApis();
    const session = await apis.auth.me();
    localStorage.setItem(viewsCollapseKey(session?.user.id ?? ''), 'collapsed');

    renderApp(<AppRoutes />, { ...asProps(apis), initialEntries: ['/tickets'] });

    expect(await screen.findByRole('button', { name: 'Views', expanded: false })).toBeVisible();
    expect(screen.queryByRole('link', { name: /^All tickets/ })).toBeNull();
  });
});
