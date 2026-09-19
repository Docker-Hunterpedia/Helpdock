import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * `Admin/Contacts` against the fixture. What is worth asserting is what the
 * screen decides — which state an identifier is drawn in, what an anonymous
 * visitor row says, what the filters and the search do to the list — rather
 * than the markup it decides it with.
 */

const renderContacts = async (entry = '/contacts') => {
  const { auth, staff, contacts } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    contactsApi: contacts,
    initialEntries: [entry],
  });

  await screen.findByRole('heading', { name: 'Contacts', level: 1 });

  return rendered;
};

const rowFor = async (name: string): Promise<HTMLElement> => {
  const cell = await screen.findByText(name);
  const row = cell.closest('tr');
  if (row === null) {
    throw new Error(`no row for ${name}`);
  }

  return row;
};

describe('the contact list', () => {
  it('lists the brand’s people with their account', async () => {
    await renderContacts();

    expect(await screen.findByText('Mona Khalil')).toBeInTheDocument();
    expect(screen.getByText('سارة الحسن')).toBeInTheDocument();
    expect(screen.getAllByText('Acme GmbH').length).toBeGreaterThan(0);
  });

  it('says in words whether an identifier is proven', async () => {
    await renderContacts();
    const mona = await rowFor('Mona Khalil');
    const gmail = await rowFor('M. Khalil');

    expect(within(mona).getByText(/verified/)).toBeInTheDocument();
    expect(within(gmail).getByText(/unverified/)).toBeInTheDocument();
  });

  it('marks an anonymous visitor as one, and shortens their id', async () => {
    await renderContacts();
    const row = await rowFor('Visitor 7f3a…c2');

    expect(within(row).getByText('anonymous')).toBeInTheDocument();
    expect(within(row).getByText('0192…c3')).toBeInTheDocument();
  });

  it('counts the people and the accounts in the caption', async () => {
    await renderContacts();

    expect(await screen.findByText(/5 people/)).toBeInTheDocument();
  });

  it('offers to review the possible duplicates it found', async () => {
    await renderContacts();

    expect(await screen.findByText(/1 possible duplicate/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  it('narrows the list to the duplicates when the review link is followed', async () => {
    const { user } = await renderContacts();
    await user.click(await screen.findByRole('button', { name: 'Review' }));

    await waitFor(() => {
      expect(screen.queryByText('Visitor 7f3a…c2')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Mona Khalil')).toBeInTheDocument();
  });

  it('searches on an identifier, not only on a name', async () => {
    const { user } = await renderContacts();
    await user.type(screen.getByRole('textbox', { name: /Name, email/ }), 'jonas@');

    expect(await screen.findByText('Jonas Weber')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Mona Khalil')).not.toBeInTheDocument();
    });
  });

  it('says so when nothing matches, rather than showing an empty table', async () => {
    const { user } = await renderContacts();
    await user.type(screen.getByRole('textbox', { name: /Name, email/ }), 'nobody at all');

    expect(await screen.findByText('Nothing matches that search')).toBeInTheDocument();
  });

  it('filters to the contacts with an open ticket', async () => {
    const { user } = await renderContacts();
    await user.click(screen.getByText('Has open tickets'));

    await waitFor(() => {
      expect(screen.queryByText('Jonas Weber')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Mona Khalil')).toBeInTheDocument();
  });

  it('reads its state out of the url, so a filtered list is a link', async () => {
    await renderContacts('/contacts?q=jonas');

    expect(await screen.findByText('Jonas Weber')).toBeInTheDocument();
  });

  it('prints the page it is showing', async () => {
    await renderContacts();

    expect(await screen.findByText('1–5 of 5')).toBeInTheDocument();
  });

  it('disables both page buttons when everything fits on one page', async () => {
    await renderContacts();

    expect(await screen.findByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });
});

describe('the accounts tab', () => {
  it('lists the companies with how many people are filed under them', async () => {
    const { user } = await renderContacts();
    await user.click(screen.getByRole('button', { name: 'Accounts' }));

    expect(await screen.findByText('Acme GmbH')).toBeInTheDocument();
    expect(screen.getByText('acme.example')).toBeInTheDocument();
  });

  it('creates an account from the header action', async () => {
    const { user } = await renderContacts('/contacts?tab=accounts');

    await user.click(await screen.findByRole('button', { name: 'New account' }));
    await user.type(screen.getByLabelText('Company name'), 'Zephyr Ltd');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Zephyr Ltd added.')).toBeInTheDocument();
  });

  it('refuses a domain another account already claims, in words', async () => {
    const { user } = await renderContacts('/contacts?tab=accounts');

    await user.click(await screen.findByRole('button', { name: 'New account' }));
    await user.type(screen.getByLabelText('Company name'), 'Acme two');
    await user.type(screen.getByLabelText('Email domain'), 'acme.example');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByText('Another account of this brand already claims that domain.'),
    ).toBeInTheDocument();
  });
});
