import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_BRAND, MOCK_CONTACT_MONA, MockContactsApi } from '../../contacts/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * The "Customer portal" section of the account page against the fixture
 * (M21-06, `Admin/Account-PortalVisibility`): the three settings, the warning
 * that appears before a wider one is saved, the manager box that only means
 * something under Managers, and the notice while the brand's portal is off.
 */

const renderAccount = async ({ portalOn = true } = {}) => {
  const apis = await signedInMockApis();
  if (portalOn) {
    await apis.ticketing.updatePortalSettings(MOCK_BRAND, {
      enabled: true,
      newCustomers: false,
      departmentIds: 'all',
    });
  }
  const acme = (await new MockContactsApi().listAccounts(MOCK_BRAND, { search: 'acme' }))
    .accounts[0];
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    initialEntries: [`/contacts/accounts/${acme?.id ?? ''}`],
  });
  const section = await screen.findByRole('region', { name: 'Customer portal' });

  return { ...rendered, apis, section, accountId: acme?.id ?? '' };
};

describe('the account page’s Customer portal section', () => {
  it('starts on Own tickets, with the managers’ boxes disabled and no warning', async () => {
    const { section } = await renderAccount();

    expect(within(section).getByRole('radio', { name: /Own tickets/ })).toBeChecked();
    expect(
      within(section).getByRole('checkbox', { name: 'Company manager: Mona Khalil' }),
    ).toBeDisabled();
    expect(within(section).queryByText(/shows people’s support history/)).not.toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(section).getByText('Never')).toBeVisible();
  });

  it('lists the members with row headers, their address and their last portal use', async () => {
    const { section } = await renderAccount();
    const table = within(section).getByRole('table', { name: 'Members' });

    expect(within(table).getByRole('rowheader', { name: /Mona Khalil/ })).toBeVisible();
    expect(within(table).getByText('mona@example.com')).toBeVisible();
    expect(within(table).getByText('2 hours ago')).toBeVisible();
  });

  it('shows the warning when Managers is chosen, enables the boxes, and saves the manager', async () => {
    const { user, section, apis, accountId } = await renderAccount();

    await user.click(within(section).getByRole('radio', { name: /Managers/ }));
    expect(within(section).getByText(/shows people’s support history/)).toBeVisible();
    const box = within(section).getByRole('checkbox', { name: 'Company manager: Mona Khalil' });
    expect(box).toBeEnabled();
    await user.click(box);
    await user.click(within(section).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Customer portal settings saved for Acme GmbH')).toBeVisible();
    const stored = await apis.contacts.accountPortal(MOCK_BRAND, accountId);
    expect(stored.visibility).toBe('managers');
    expect(stored.members.find((member) => member.contactId === MOCK_CONTACT_MONA)?.role).toBe(
      'manager',
    );
  });

  it('shows the warning for All members too, and drops it when Own tickets is chosen again', async () => {
    const { user, section } = await renderAccount();

    await user.click(within(section).getByRole('radio', { name: /All members/ }));
    expect(within(section).getByText(/shows people’s support history/)).toBeVisible();
    await user.click(within(section).getByRole('radio', { name: /Own tickets/ }));
    expect(within(section).queryByText(/shows people’s support history/)).not.toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('discards the draft', async () => {
    const { user, section } = await renderAccount();

    await user.click(within(section).getByRole('radio', { name: /All members/ }));
    await user.click(within(section).getByRole('button', { name: 'Discard' }));

    expect(within(section).getByRole('radio', { name: /Own tickets/ })).toBeChecked();
  });

  it('says the portal is off, with a link to its settings', async () => {
    const { section } = await renderAccount({ portalOn: false });

    expect(within(section).getByText(/The customer portal is off for this brand/)).toBeVisible();
    expect(within(section).getByRole('link', { name: 'Portal settings' })).toHaveAttribute(
      'href',
      '/settings/channels/portal',
    );
  });

  it('keeps the draft and says so when the save fails', async () => {
    const { user, section, apis } = await renderAccount();
    apis.contacts.saveAccountPortal = () => Promise.reject(new Error('boom'));

    await user.click(within(section).getByRole('radio', { name: /All members/ }));
    await user.click(within(section).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(
        screen.getByText('Could not save the portal setting. Nothing was changed. Try again.'),
      ).toBeVisible();
    });
    expect(within(section).getByRole('radio', { name: /All members/ })).toBeChecked();
  });
});
