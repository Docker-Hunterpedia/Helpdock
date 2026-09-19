import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MOCK_BRAND, MockContactsApi } from '../../contacts/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * The create form and the account screen, which are the two routes the list
 * sends people to.
 */

const renderAt = async (entry: string) => {
  const { auth, staff, contacts } = await signedInMockApis();

  return renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    contactsApi: contacts,
    initialEntries: [entry],
  });
};

const accountIdOf = async (search: string): Promise<string> => {
  const accounts = await new MockContactsApi().listAccounts(MOCK_BRAND, { search });

  return accounts.accounts[0]?.id ?? '';
};

describe('the account screen', () => {
  it('names the company and lists the people filed under it', async () => {
    await renderAt(`/contacts/accounts/${await accountIdOf('acme')}`);

    expect(await screen.findByRole('heading', { name: 'Acme GmbH', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Mona Khalil')).toBeInTheDocument();
    expect(screen.getByText('Jonas Weber')).toBeInTheDocument();
  });

  it('says so when nobody is filed under it yet', async () => {
    await renderAt(`/contacts/accounts/${await accountIdOf('nordwind')}`);

    expect(await screen.findByText('Nobody is filed here yet')).toBeInTheDocument();
  });

  it('renames the company', async () => {
    const { user } = await renderAt(`/contacts/accounts/${await accountIdOf('nordwind')}`);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Company name');
    await user.clear(name);
    await user.type(name, 'Nordwind GmbH');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Nordwind GmbH updated.')).toBeInTheDocument();
  });
});

describe('the create form', () => {
  it('creates a contact with one identifier and opens it', async () => {
    const { user } = await renderAt('/contacts/new');

    await user.type(await screen.findByLabelText('Name'), 'Rami Saleh');
    await user.type(screen.getByLabelText('Identifier'), 'Rami@Example.com');
    await user.click(screen.getByRole('button', { name: 'Create contact' }));

    expect(await screen.findByText('Rami Saleh added.')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Rami Saleh', level: 1 }),
    ).toBeInTheDocument();
    // Normalised on the way in, so the same address typed two ways is one row.
    expect(screen.getByText(/rami@example\.com unverified/)).toBeInTheDocument();
  });

  it('refuses an identifier another contact already holds, in words', async () => {
    const { user } = await renderAt('/contacts/new');

    await user.type(await screen.findByLabelText('Name'), 'Impostor');
    await user.type(screen.getByLabelText('Identifier'), 'mona@example.com');
    await user.click(screen.getByRole('button', { name: 'Create contact' }));

    expect(
      await screen.findByText('Another contact in this brand already holds that identifier.'),
    ).toBeInTheDocument();
  });

  it('goes back to the list when the form is cancelled', async () => {
    const { user } = await renderAt('/contacts/new');

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Contacts', level: 1 })).toBeInTheDocument();
    });
  });
});
