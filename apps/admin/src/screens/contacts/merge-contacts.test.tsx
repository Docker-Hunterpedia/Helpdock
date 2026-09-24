import type { ContactDetail, ContactMergeRequest } from '@helpdock/schemas';
import { screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { ContactError } from '../../contacts/api.js';
import {
  MOCK_CONTACT_GMAIL,
  MOCK_CONTACT_MONA,
  MOCK_DUPLICATE,
  MockContactsApi,
} from '../../contacts/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * M1-13 on `Admin/Contact`: the merge dialog, the toast with its Undo, the
 * banner on the survivor, and the redirect from a contact that was merged away.
 */

const renderContact = async (
  contactsApi: MockContactsApi = new MockContactsApi(),
  contactId = MOCK_CONTACT_MONA,
  name = 'Mona Khalil',
) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    contactsApi,
    initialEntries: [`/contacts/${contactId}`],
  });

  await screen.findByRole('heading', { name, level: 1 });

  return { ...rendered, contactsApi };
};

const openDialog = async (user: ReturnType<typeof renderApp>['user']) => {
  const card = await screen.findByRole('region', { name: 'Identities' });
  await user.click(within(card).getByRole('button', { name: 'Merge with M. Khalil' }));

  const dialog = await screen.findByRole('dialog', { name: /Merge contacts/ });
  await within(dialog).findByText('Keep the name and details of');

  return dialog;
};

/** Merge, then wait for the dialog to go: until it has, the page behind it is `aria-hidden`. */
const merge = async (
  user: ReturnType<typeof renderApp>['user'],
  dialog: HTMLElement,
): Promise<void> => {
  await user.click(within(dialog).getByRole('button', { name: 'Merge contacts' }));
  await waitForElementToBeRemoved(dialog, { timeout: 5_000 });
};

describe('the merge dialog', () => {
  it('shows both sides with their ticket counts and every identifier with its state', async () => {
    const { user } = await renderContact();

    const dialog = await openDialog(user);

    expect(
      within(dialog).getByText('M. Khalil looks like the same person: email typed in a form.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Mona Khalil/ })).toBeChecked();
    expect(within(dialog).getByText('6 tickets')).toBeInTheDocument();
    expect(within(dialog).getByText('1 ticket')).toBeInTheDocument();
    expect(within(dialog).getByText('mona.k@gmail.com')).toBeInTheDocument();
    expect(within(dialog).getAllByText('unverified').length).toBeGreaterThan(0);
    expect(
      within(dialog).getByText(/Both contacts' tickets move to Mona Khalil/),
    ).toBeInTheDocument();
  });

  it('keeps whichever contact the agent chooses, and says who in the note', async () => {
    const { user } = await renderContact();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('radio', { name: /M\. Khalil/ }));

    expect(within(dialog).getByText(/tickets move to M\. Khalil/)).toBeInTheDocument();
  });

  it('merges, toasts with an Undo, and shows the banner on the survivor', async () => {
    const { user } = await renderContact();
    const dialog = await openDialog(user);

    await merge(user, dialog);

    expect(await screen.findByText('Merged M. Khalil into Mona Khalil.')).toBeInTheDocument();
    expect(
      await screen.findByText(/M\. Khalil was merged into this contact by Lina Haddad/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Possible duplicate: M. Khalil')).not.toBeInTheDocument();
    const identities = await screen.findByRole('region', { name: 'Identities' });
    expect(within(identities).getByText(/mona\.k@gmail\.com/)).toBeInTheDocument();
  });

  it('undoes from the toast, and the duplicate comes back', async () => {
    const { user } = await renderContact();
    await merge(user, await openDialog(user));

    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByText('Merge undone. M. Khalil is a separate contact again.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Possible duplicate: M. Khalil')).toBeInTheDocument();
  });

  it('undoes from the banner', async () => {
    const { user } = await renderContact();
    await merge(user, await openDialog(user));

    await user.click(await screen.findByRole('button', { name: /Undo · until/ }));

    await waitFor(() => {
      expect(screen.queryByText(/was merged into this contact/)).not.toBeInTheDocument();
    });
  });

  it('follows the survivor when the other contact is kept', async () => {
    const { user } = await renderContact();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: /M\. Khalil/ }));

    await user.click(within(dialog).getByRole('button', { name: 'Merge contacts' }));

    expect(
      await screen.findByRole('heading', { name: 'M. Khalil', level: 1 }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('says in words why a merge was refused', async () => {
    class RefusingApi extends MockContactsApi {
      override async mergeContacts(
        _brandId: string,
        _survivorId: string,
        _request: ContactMergeRequest,
      ): Promise<ContactDetail> {
        throw new ContactError('merged');
      }
    }
    const { user } = await renderContact(new RefusingApi());
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'Merge contacts' }));

    expect(
      await screen.findByText('This contact was merged into another. Open that one instead.'),
    ).toBeInTheDocument();
  });
});

describe('a contact that was merged away', () => {
  it('sends the viewer on to the contact it was merged into', async () => {
    const contactsApi = new MockContactsApi();
    await contactsApi.mergeContacts('brand', MOCK_CONTACT_MONA, {
      mergedContactId: MOCK_CONTACT_GMAIL,
      suggestionId: MOCK_DUPLICATE,
    });

    await renderContact(contactsApi, MOCK_CONTACT_GMAIL, 'Mona Khalil');

    expect(screen.getByRole('heading', { name: 'Mona Khalil', level: 1 })).toBeInTheDocument();
  });
});
