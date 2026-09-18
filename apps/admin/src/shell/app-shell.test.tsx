import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApi } from '../test/signed-in.js';

const renderShell = async (path = '/tickets') => {
  const rendered = renderApp(<AppRoutes />, {
    authApi: await signedInMockApi(),
    initialEntries: [path],
  });
  await screen.findByRole('navigation', { name: 'Main' });

  return rendered;
};

describe('AppShell', () => {
  it('lists every destination as a link in one named navigation', async () => {
    await renderShell();
    const nav = screen.getByRole('navigation', { name: 'Main' });

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Tickets24',
      'Contacts812',
      'Help center36',
      'Reports9',
      'Settings',
      'Staff and roles',
      'System',
    ]);
  });

  it('marks the open page for assistive technology, not only by shading it', async () => {
    await renderShell('/admin/staff');

    expect(screen.getByRole('link', { current: 'page' })).toHaveTextContent('Staff and roles');
  });

  it('says what a page will hold and which milestone brings it', async () => {
    await renderShell('/reports');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reports');
    expect(
      screen.getByText('Volume, response times, SLA and CSAT for this brand.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Reports arrive with milestone M8.')).toBeInTheDocument();
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
});
