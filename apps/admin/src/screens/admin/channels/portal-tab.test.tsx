import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { settingsLink } from '../../../test/settings-nav.js';
import { signedInMockApis } from '../../../test/signed-in.js';
import { MOCK_FAIL_PORTAL_SETTINGS_KEY } from '../../../ticketing/mock-api.js';

/**
 * Channels › Customer portal against the fixture (M21-06,
 * `Admin/Channels-CustomerPortal`): the page opens by its url, Save and Discard
 * follow what changed, "only these" cannot be saved empty, and a failed save
 * keeps what was typed.
 */

const renderPortal = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    initialEntries: ['/settings/channels/portal'],
  });
  const form = await screen.findByRole('form', { name: 'Customer portal settings' });

  return { ...rendered, apis, form };
};

afterEach(() => {
  window.localStorage.removeItem(MOCK_FAIL_PORTAL_SETTINGS_KEY);
});

describe('Channels › Customer portal', () => {
  it('opens by its url, names the page, and says the portal is off by default', async () => {
    const { form } = await renderPortal();

    expect(settingsLink('Customer portal')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Customer portal', level: 1 })).toBeVisible();
    expect(screen.getByText(/The portal is off\./)).toBeVisible();
    expect(within(form).getByRole('switch', { name: 'Customer portal' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(within(form).getByRole('switch', { name: 'New customers may sign in' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(within(form).getByText(/\/tickets$/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('links to the accounts and to the email page', async () => {
    await renderPortal();
    const related = screen.getByRole('navigation', { name: 'Related' });

    expect(
      within(related).getByRole('link', {
        name: 'Who in a company sees its tickets is set on each account',
      }),
    ).toHaveAttribute('href', '/contacts/accounts');
    expect(
      within(related).getByRole('link', {
        name: 'The sign-in email uses your customer email design',
      }),
    ).toHaveAttribute('href', '/settings/channels/outgoing');
  });

  it('turns the portal on, saves, and drops the off notice', async () => {
    const { user, apis } = await renderPortal();

    await user.click(screen.getByRole('switch', { name: 'Customer portal' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Customer portal settings saved')).toBeVisible();
    expect((await apis.ticketing.brand('b')).settings.portal).toEqual({
      enabled: true,
      newCustomers: false,
      departmentIds: 'all',
    });
    await waitFor(() => {
      expect(screen.queryByText(/The portal is off\./)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('puts the choice of departments in a fieldset of radios, and ticks them', async () => {
    const { user, apis } = await renderPortal();

    const group = screen.getByRole('group', { name: /Departments shown/ });
    expect(within(group).getByRole('radio', { name: /All departments/ })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: /Only these/ }));
    expect(screen.getByText('Choose at least one department.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Billing' }));
    expect(screen.queryByText('Choose at least one department.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Customer portal settings saved');

    const stored = (await apis.ticketing.brand('b')).settings.portal.departmentIds;
    expect(stored).toHaveLength(1);
  });

  it('discards what was changed', async () => {
    const { user } = await renderPortal();

    await user.click(screen.getByRole('switch', { name: 'New customers may sign in' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByRole('switch', { name: 'New customers may sign in' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps the values and shows the banner when the save fails', async () => {
    const { user, apis } = await renderPortal();
    window.localStorage.setItem(MOCK_FAIL_PORTAL_SETTINGS_KEY, '1');

    await user.click(screen.getByRole('switch', { name: 'Customer portal' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'Could not save the portal settings. Nothing was changed. Try again.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Customer portal' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect((await apis.ticketing.brand('b')).settings.portal.enabled).toBe(false);
  });
});
