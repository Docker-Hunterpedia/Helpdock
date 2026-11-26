import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_CONTACT_ACCOUNT, MOCK_CONTACT_MONA } from '../../contacts/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * The "Customer portal" card of the contact page against the fixture (M21-06,
 * `Admin/Contact-PortalAccess`): signed in with its sessions, never signed in,
 * and Sign out everywhere behind the confirmation.
 */

const renderContact = async (contactId: string) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    initialEntries: [`/contacts/${contactId}`],
  });
  const card = await screen.findByRole('region', { name: 'Customer portal' });

  return { ...rendered, apis, card };
};

describe('the contact page’s Customer portal card', () => {
  it('shows who has signed in, with what, what they see and each browser', async () => {
    const { card } = await renderContact(MOCK_CONTACT_MONA);

    expect(await within(card).findByText('Signed in')).toBeVisible();
    expect(within(card).getByText('mona@example.com')).toBeVisible();
    expect(within(card).getByText(/Own tickets only/)).toBeVisible();
    const sessions = within(card).getByRole('list', { name: 'Sessions' });
    expect(within(sessions).getAllByRole('listitem')).toHaveLength(2);
    expect(within(sessions).getByText('Chrome on macOS')).toBeVisible();
    expect(within(sessions).getByText(/Last used 2 hours ago/)).toBeVisible();
    expect(within(sessions).getAllByText('help.helpdock.example')).toHaveLength(2);
  });

  it('says a contact has not signed in, and offers no sign-out', async () => {
    const { card } = await renderContact(MOCK_CONTACT_ACCOUNT);

    expect(
      await within(card).findByText('Jonas has not signed in to the customer portal.'),
    ).toBeVisible();
    expect(
      within(card).queryByRole('button', { name: 'Sign out everywhere' }),
    ).not.toBeInTheDocument();
  });

  it('asks before it signs out, counts the sessions, and signs out', async () => {
    const { user, card, apis } = await renderContact(MOCK_CONTACT_MONA);

    await user.click(await within(card).findByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Sign Mona Khalil out of the portal?',
    });
    expect(within(dialog).getByText(/This ends their 2 portal sessions/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

    expect(await screen.findByText('Signed Mona Khalil out of the portal')).toBeVisible();
    await waitFor(() => {
      expect(
        within(card).getByText('Mona has not signed in to the customer portal.'),
      ).toBeVisible();
    });
    const after = await apis.contacts.contactPortal('b', MOCK_CONTACT_MONA);
    expect(after.signedIn).toBe(false);
  });

  it('leaves the sessions alone when the dialog is cancelled', async () => {
    const { user, card, apis } = await renderContact(MOCK_CONTACT_MONA);

    await user.click(await within(card).findByRole('button', { name: 'Sign out everywhere' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect((await apis.contacts.contactPortal('b', MOCK_CONTACT_MONA)).sessions).toHaveLength(2);
  });
});
