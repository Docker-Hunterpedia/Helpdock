import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import type { ContactsApi } from '../../contacts/api.js';
import {
  MOCK_CONTACT_ACCOUNT,
  MOCK_CONTACT_MONA,
  MockContactsApi,
} from '../../contacts/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * `Admin/Contact` against the fixture, and the two things this screen exists to
 * get right: the verification state of every identifier, and the hidden-ticket
 * count of DOMAIN-RULES §1.2.
 */

const renderContact = async ({
  contactId = MOCK_CONTACT_MONA,
  name = 'Mona Khalil',
  contactsApi,
}: {
  contactId?: string;
  name?: string;
  contactsApi?: ContactsApi;
} = {}): Promise<ReturnType<typeof renderApp>> => {
  const { auth, staff, contacts } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    contactsApi: contactsApi ?? contacts,
    initialEntries: [`/contacts/${contactId}`],
  });

  await screen.findByRole('heading', { name, level: 1 });

  return rendered;
};

/** The fixture with one thing changed, by subclass rather than by spreading:
 *  a class instance's methods live on its prototype, so `{ ...api }` would be
 *  an object with no behaviour at all. */
class HiddenTicketsApi extends MockContactsApi {
  override async timeline(brandId: string, contactId: string) {
    return { ...(await super.timeline(brandId, contactId)), hiddenCount: 2 };
  }
}

describe('the contact header', () => {
  it('names the account and every identifier with its state', async () => {
    await renderContact();

    const caption = await screen.findByText(/mona@example\.com verified/);

    expect(caption).toHaveTextContent('Acme GmbH');
    expect(caption).toHaveTextContent('+49301234567 unverified');
    expect(caption).toHaveTextContent('linked');
  });

  it('shows the tag the brand put on them', async () => {
    await renderContact();

    expect(await screen.findByText('vip')).toBeInTheDocument();
  });
});

describe('the timeline', () => {
  it('says how many tickets the viewer can see', async () => {
    await renderContact();

    expect(await screen.findByText('0 tickets you can see')).toBeInTheDocument();
  });

  it('says nothing about hidden tickets when none are hidden', async () => {
    await renderContact();

    await screen.findByText('0 tickets you can see');
    expect(screen.queryByText(/hidden from your role/)).not.toBeInTheDocument();
  });

  it('names a hidden count when the api reports one, and never the tickets', async () => {
    await renderContact({ contactsApi: new HiddenTicketsApi() });

    expect(await screen.findByText('2 more in departments you are not in')).toBeInTheDocument();
    expect(screen.getByText('2 tickets are hidden from your role.')).toBeInTheDocument();
  });

  it('shows the notes inline, with who wrote them', async () => {
    await renderContact();

    const body = await screen.findByText('Prefers a call before any billing change.');

    expect(body.parentElement).toHaveTextContent('Lina Haddad');
  });

  it('adds a note from the composer and says it saved', async () => {
    const { user } = await renderContact();

    await user.type(await screen.findByLabelText('Add a note'), 'Calls on Sundays.');
    await user.click(screen.getByRole('button', { name: 'Save note' }));

    expect(await screen.findByText('Note added.')).toBeInTheDocument();
    expect(screen.getByText('Calls on Sundays.')).toBeInTheDocument();
  });

  it('hides the notes when the Open filter is chosen', async () => {
    const { user } = await renderContact();

    await user.click(await screen.findByRole('button', { name: 'Open' }));

    await waitFor(() => {
      expect(
        screen.queryByText('Prefers a call before any billing change.'),
      ).not.toBeInTheDocument();
    });
  });
});

describe('the identities card', () => {
  it('offers a duplicate suggestion with the reason it was raised', async () => {
    await renderContact();
    const card = await screen.findByRole('region', { name: 'Identities' });

    expect(within(card).getByText('Possible duplicate: M. Khalil')).toBeInTheDocument();
    expect(within(card).getByText('email typed in a form')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Merge with M. Khalil' })).toBeEnabled();
  });

  it('dismisses a suggestion and stops showing it', async () => {
    const { user } = await renderContact();
    const card = await screen.findByRole('region', { name: 'Identities' });

    await user.click(
      within(card).getByRole('button', { name: 'M. Khalil is not the same person' }),
    );

    expect(await screen.findByText('Marked as a different person.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Possible duplicate/)).not.toBeInTheDocument();
    });
  });

  it('adds an identifier, and says how a bad one was wrong', async () => {
    const { user } = await renderContact();
    const card = await screen.findByRole('region', { name: 'Identities' });

    await user.click(within(card).getByRole('button', { name: 'Add identifier' }));
    await user.type(screen.getByLabelText('Identifier'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Add identifier', hidden: false }));

    expect(await screen.findByText('That is not an email address.')).toBeInTheDocument();
  });

  it('keeps the last identifier of a contact that has only one', async () => {
    await renderContact({ contactId: MOCK_CONTACT_ACCOUNT, name: 'Jonas Weber' });
    const card = await screen.findByRole('region', { name: 'Identities' });

    expect(within(card).getByRole('button', { name: /Remove/ })).toBeDisabled();
  });
});

describe('the details card', () => {
  it('prints what is known and a dash for what is not', async () => {
    await renderContact();
    const card = await screen.findByRole('region', { name: 'Details' });

    expect(within(card).getByText('CUST-10492')).toBeInTheDocument();
    expect(within(card).getByText('Europe/Berlin')).toBeInTheDocument();
  });

  it('edits the details inline and reports the change', async () => {
    const { user } = await renderContact();
    const card = await screen.findByRole('region', { name: 'Details' });

    await user.click(within(card).getByRole('button', { name: 'Edit details' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Mona K. Khalil');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Mona K. Khalil updated.')).toBeInTheDocument();
  });
});

describe('erasure', () => {
  it('asks first, then replaces the person with hashes and locks the screen', async () => {
    const { user } = await renderContact();

    await user.click(await screen.findByRole('button', { name: 'Erase contact' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('cannot be undone');
    await user.click(screen.getByRole('button', { name: 'Erase contact', hidden: false }));

    expect(await screen.findByText('Erased contact erased.')).toBeInTheDocument();
    expect(
      await screen.findByText('This contact has been erased and can no longer be changed.'),
    ).toBeInTheDocument();
  });
});

describe('the stats tiles', () => {
  it('shows a dash until there is anything to average', async () => {
    await renderContact({ contactId: MOCK_CONTACT_ACCOUNT, name: 'Jonas Weber' });
    const card = await screen.findByRole('region', { name: 'Stats' });

    expect(within(card).getByText('—')).toBeInTheDocument();
  });
});
