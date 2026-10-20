import type { Session } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import type { MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { SIDEBAR_STORAGE_KEY } from './sidebar-collapse.js';

/**
 * System and Settings are install-wide — schema, queues, database role and
 * authentication providers — so the nav offers them only to an install admin.
 * "Staff and roles" is offered to the two roles that hold `staff:manage`.
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
  it('offers System to an install admin', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).toContain('System');
  });

  it('does not offer install-wide destinations to a brand admin', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser({ installAdmin: false })),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).not.toContain('System');
    expect(navLinks()).not.toContain('Settings');
    expect(navLinks()).toContain('Staff and roles');
    expect(navLinks()).toContain('Developers');
  });

  /** DOMAIN-RULES §1.2: only an Admin and a Team Leader hold `staff:manage`. */
  it.each(['agent', 'viewer'] as const)('does not offer Staff and roles to %s', async (role) => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser({ role, installAdmin: false })),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).not.toContain('Staff and roles');
    expect(navLinks()).not.toContain('Settings');
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

  it('offers Staff and roles to a Team Leader', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser({ role: 'teamLeader', installAdmin: false })),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).toContain('Staff and roles');
    // API keys and webhooks act for the whole brand: `brand:manage` (M8-01, M8-03).
    expect(navLinks()).not.toContain('Developers');
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
