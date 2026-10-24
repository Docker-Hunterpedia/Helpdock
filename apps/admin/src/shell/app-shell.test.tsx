import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';

/** `signedInMockApis` names the pair the way the app does; `renderApp` names them as props. */
const signedIn = ({ auth, staff }: Awaited<ReturnType<typeof signedInMockApis>>) => ({
  authApi: auth,
  staffApi: staff,
});

/**
 * Every media query answers "no", which is what a phone-width viewport looks
 * like to the 1024 px query the shell asks. happy-dom has no layout, so the
 * query is the only thing there is to answer.
 */
const narrowViewport = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
};

const renderShell = async (path = '/tickets') => {
  const rendered = renderApp(<AppRoutes />, {
    ...signedIn(await signedInMockApis()),
    initialEntries: [path],
  });
  await screen.findByRole('navigation', { name: 'Main' });

  return rendered;
};

describe('AppShell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prints a primary count only for the keys the session carries', async () => {
    const apis = await signedInMockApis();
    const session = await apis.auth.me();
    vi.spyOn(apis.auth, 'me').mockResolvedValue(
      session === null ? null : { ...session, navCounts: { tickets: 24 } },
    );
    renderApp(<AppRoutes />, { ...signedIn(apis), initialEntries: ['/tickets'] });
    const nav = await screen.findByRole('navigation', { name: 'Main' });

    expect(await within(nav).findByRole('link', { name: /^Tickets\s*24$/ })).toBeVisible();
    expect(within(nav).getByRole('link', { name: /^Contacts$/ })).toBeVisible();
  });

  it('lists every destination as a link in one named navigation', async () => {
    await renderShell();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    // The views and their counts are two reads, so the group is only complete
    // once the counts have arrived (M1-05).
    await screen.findByRole('link', { name: /^Escalated 1$/ });

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      // The api sends no primary counts in 1.0 (UX-24), so the fixture has none.
      'Tickets',
      // The + beside "Views": an icon link, named by its aria-label.
      '',
      'All tickets',
      'My open5',
      'Snoozed0',
      'Unassigned2',
      'Overdue3',
      'All open · Support6',
      'All open · Billing1',
      'All open · Onboarding1',
      'Escalated1',
      'VIP refunds1',
      'Urgent, mine1',
      'Contacts',
      'Help center',
      'Reports',
      // The one entry for everything that was the Admin group (M14-21).
      'Settings',
    ]);
  });

  it('marks the open page for assistive technology, not only by shading it', async () => {
    await renderShell('/settings/install/staff');

    expect(
      within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('link', {
        current: 'page',
      }),
    ).toHaveTextContent('Staff and roles');
  });

  it('opens the install-wide authentication settings instead of the M0 placeholder', async () => {
    await renderShell('/settings/install/authentication');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Authentication');
    expect(screen.getByText('Install-wide · applies to every brand')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Sign-in methods' })).toBeInTheDocument();
    expect(screen.getByLabelText('Sign-in link validity (minutes)')).toHaveValue(10);
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
  });

  it('switches brand from the menu and marks the one in force', async () => {
    const { user } = await renderShell();

    await user.click(screen.getByRole('button', { name: 'Switch brand' }));
    const menu = await screen.findByRole('menu', { name: 'Switch brand' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Helpdock' })).toBeChecked();

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Helpdock EU' }));

    expect(await screen.findByRole('button', { name: 'Switch brand' })).toHaveTextContent(
      'Helpdock EU',
    );
  });

  it('flips the whole shell to Arabic from the account menu', async () => {
    const { user } = await renderShell();

    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Switch to العربية' }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    });
    expect(screen.getByRole('navigation', { name: 'التنقّل الرئيسي' })).toBeInTheDocument();
  });

  it('signs out back to the sign-in screen', async () => {
    const { user } = await renderShell();

    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('puts the navigation in a drawer below 1024 px and closes it on navigation', async () => {
    narrowViewport();
    const { user } = renderApp(<AppRoutes />, {
      ...signedIn(await signedInMockApis()),
      initialEntries: ['/tickets'],
    });

    const open = await screen.findByRole('button', { name: 'Open navigation' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

    await user.click(open);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await user.click(within(nav).getByRole('link', { name: /Contacts/ }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Contacts');
    });
    // Leaving it open would hide the page it just navigated to.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  describe('presence (M0-13)', () => {
    const footer = () => screen.getByRole('button', { name: 'Account menu for Lina Haddad' });

    it('shows the status in words beside the dot, not as a colour alone', async () => {
      await renderShell();

      await waitFor(() => expect(footer()).toHaveTextContent('Install admin · Online'));
      expect(footer().querySelector('[data-status]')).toHaveAttribute('data-status', 'online');
    });

    it('toggles to away from the account menu and back again', async () => {
      const { user } = await renderShell();
      await waitFor(() => expect(footer()).toHaveTextContent('Online'));

      await user.click(footer());
      await user.click(await screen.findByRole('menuitem', { name: 'Set yourself away' }));

      await waitFor(() => expect(footer()).toHaveTextContent('Install admin · Away'));
      expect(footer().querySelector('[data-status]')).toHaveAttribute('data-status', 'away');

      await user.click(footer());
      await user.click(await screen.findByRole('menuitem', { name: 'Set yourself online' }));

      await waitFor(() => expect(footer()).toHaveTextContent('Install admin · Online'));
    });
  });
});
