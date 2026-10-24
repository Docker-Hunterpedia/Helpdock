import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { MOCK_ROLE_STORAGE } from '../auth/mock-api.js';
import {
  MOCK_CURRENT_PASSWORD,
  MOCK_RESET_BLOCKED_PASSWORD,
  MockStaffApi,
} from '../staff/mock-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';

/**
 * `Admin/Staff` against the fixture. What is worth asserting here is what the
 * screen decides — which rows offer which actions, which confirmations are
 * asked for, and which refusal turns into which sentence — rather than the
 * markup it decides them with.
 */

const renderStaff = async (staffApi?: MockStaffApi) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staffApi ?? staff,
    initialEntries: ['/settings/install/staff'],
  });

  await screen.findByRole('heading', { name: 'Staff and roles', level: 1 });

  return rendered;
};

/** Addressed by the email, which is unique; a name is not. */
const rowFor = async (email: string): Promise<HTMLElement> => {
  const cell = await screen.findByText(email);
  const row = cell.closest('tr');
  if (row === null) {
    throw new Error(`no row for ${email}`);
  }

  return row;
};

const openRowMenu = async (
  user: ReturnType<typeof renderApp>['user'],
  email: string,
  name: string,
): Promise<void> => {
  const row = await rowFor(email);
  await user.click(within(row).getByRole('button', { name: `Actions for ${name}` }));
};

describe('the staff table', () => {
  it('lists everybody with a role in the brand', async () => {
    await renderStaff();

    expect(await screen.findByText('Omar Nasser')).toBeInTheDocument();
    expect(screen.getByText('Yara Salem')).toBeInTheDocument();
    expect(screen.getByText('Dana Fares')).toBeInTheDocument();
  });

  it('says how many people there are and whether the Viewer role is on', async () => {
    await renderStaff();

    expect(await screen.findByText(/5 people · Viewer role enabled/)).toBeInTheDocument();
  });

  it('shows a pending invitation with when it was sent and when it lapses', async () => {
    await renderStaff();
    const row = await rowFor('karim@helpdock.com');

    expect(within(row).getByText(/Invited 3 days ago · expires in 4 days/)).toBeInTheDocument();
  });

  it('offers no actions on your own row', async () => {
    await renderStaff();
    const row = await rowFor('lina@helpdock.com');

    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers resend and revoke on a pending invitation, and nothing else', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'karim@helpdock.com', 'karim');

    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Resend invite', 'Revoke invite']);
  });

  it('offers reactivate rather than deactivate on a deactivated person', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'dana@helpdock.com', 'Dana Fares');

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Reactivate' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Deactivate' })).not.toBeInTheDocument();
  });

  it('narrows the list as the search is typed', async () => {
    const { user } = await renderStaff();

    await user.type(screen.getByLabelText('Search people'), 'omar');

    await waitFor(() => {
      expect(screen.queryByText('Yara Salem')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Omar Nasser')).toBeInTheDocument();
  });

  it('says so when a search matches nobody', async () => {
    const { user } = await renderStaff();

    await user.type(screen.getByLabelText('Search people'), 'nobody at all');

    expect(await screen.findByText('No one matches that search')).toBeInTheDocument();
  });
});

describe('inviting somebody', () => {
  it('sends an invitation and says where it went', async () => {
    const { user } = await renderStaff();

    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await user.type(await screen.findByLabelText('Email'), 'new.person@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(
      await screen.findByText('Invitation sent to new.person@example.com.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('new.person@example.com')).toBeInTheDocument();
  });

  it('refuses a malformed address before asking the api', async () => {
    const { user } = await renderStaff();

    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await user.type(await screen.findByLabelText('Email'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(
      await screen.findByText('Enter an email address like name@example.com.'),
    ).toBeInTheDocument();
  });

  it('asks for an address at all', async () => {
    const { user } = await renderStaff();

    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await user.click(await screen.findByRole('button', { name: 'Send invite' }));

    expect(await screen.findByText('Enter an email address.')).toBeInTheDocument();
  });

  it('offers the four roles with a sentence each', async () => {
    const { user } = await renderStaff();

    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const group = await screen.findByRole('radiogroup');

    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByText('Works tickets in chosen departments')).toBeInTheDocument();
  });

  it('leaves the Viewer card out when the install has the role turned off', async () => {
    const staff = new MockStaffApi();
    staff.setViewerEnabled(false);
    const { user } = await renderStaff(staff);

    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const group = await screen.findByRole('radiogroup');

    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByText('The Viewer role is turned off for this install.')).toBeInTheDocument();
  });
});

describe('changing somebody', () => {
  it('confirms before deactivating, and says so afterwards', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'yara@helpdock.com', 'Yara Salem');

    await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));
    expect(await screen.findByText('Deactivate Yara Salem?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText('Yara Salem was deactivated.')).toBeInTheDocument();
  });

  it('leaves everything alone when the confirmation is cancelled', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'yara@helpdock.com', 'Yara Salem');

    await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Deactivate Yara Salem?')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Yara Salem was deactivated.')).not.toBeInTheDocument();
  });

  it('changes a role and names the new one', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'yara@helpdock.com', 'Yara Salem');

    await user.click(await screen.findByRole('menuitem', { name: 'Change role' }));
    const group = await screen.findByRole('radiogroup');
    await user.click(within(group).getByRole('radio', { name: /Viewer/ }));
    await user.click(screen.getByRole('button', { name: 'Save role' }));

    expect(await screen.findByText('Yara Salem is now Viewer in Helpdock.')).toBeInTheDocument();
  });

  it('removes somebody from the brand after a confirmation', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'omar@helpdock.com', 'Omar Nasser');

    await user.click(await screen.findByRole('menuitem', { name: 'Remove from Helpdock' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('Omar Nasser was removed from Helpdock.')).toBeInTheDocument();
  });
});

describe('a pending invitation', () => {
  it('can be resent', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'karim@helpdock.com', 'karim');

    await user.click(await screen.findByRole('menuitem', { name: 'Resend invite' }));

    expect(
      await screen.findByText('A new invitation is on its way to karim@helpdock.com.'),
    ).toBeInTheDocument();
  });

  it('can be revoked, after a confirmation naming the address', async () => {
    const { user } = await renderStaff();
    await openRowMenu(user, 'karim@helpdock.com', 'karim');

    await user.click(await screen.findByRole('menuitem', { name: 'Revoke invite' }));
    expect(
      await screen.findByText('Revoke the invitation to karim@helpdock.com?'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke invite' }));

    expect(
      await screen.findByText('The invitation to karim@helpdock.com was revoked.'),
    ).toBeInTheDocument();
  });
});

describe('resetting a second factor (#398)', () => {
  const openReset = async (user: ReturnType<typeof renderApp>['user']): Promise<void> => {
    await openRowMenu(user, 'omar@helpdock.com', 'Omar Nasser');
    await user.click(await screen.findByRole('menuitem', { name: /Reset second factor/ }));
  };

  const stepUp = async (
    user: ReturnType<typeof renderApp>['user'],
    password: string,
  ): Promise<void> => {
    await user.type(await screen.findByLabelText('Password or 6-digit code'), password);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
  };

  it('is offered on another active person who has a second factor, and nowhere else', async () => {
    const { user } = await renderStaff();

    await openRowMenu(user, 'omar@helpdock.com', 'Omar Nasser');
    expect(
      within(await screen.findByRole('menu')).getByRole('menuitem', {
        name: /Reset second factor/,
      }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    await openRowMenu(user, 'yara@helpdock.com', 'Yara Salem');
    expect(
      within(await screen.findByRole('menu')).queryByRole('menuitem', {
        name: /Reset second factor/,
      }),
    ).not.toBeInTheDocument();
  });

  it('is not offered to a staff member who is not an install admin', async () => {
    localStorage.setItem(MOCK_ROLE_STORAGE, 'admin');
    try {
      const { user } = await renderStaff();

      await openRowMenu(user, 'omar@helpdock.com', 'Omar Nasser');

      expect(
        within(await screen.findByRole('menu')).queryByRole('menuitem', {
          name: /Reset second factor/,
        }),
      ).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem(MOCK_ROLE_STORAGE);
    }
  });

  it('confirms with the step-up, lists what goes with live counts, then marks the row not set up', async () => {
    const { user } = await renderStaff();
    await openReset(user);

    await stepUp(user, MOCK_CURRENT_PASSWORD);
    expect(await screen.findByText("Reset Omar Nasser's second factor?")).toBeInTheDocument();
    expect(
      screen.getByText(/They can set up a second factor again from their security page/),
    ).toBeInTheDocument();
    expect(screen.getByText('Authenticator app')).toBeInTheDocument();
    expect(screen.getByText('2 passkeys')).toBeInTheDocument();
    expect(screen.getByText('6 unused recovery codes')).toBeInTheDocument();
    expect(
      screen.getByText(/Whoever knows their password can set up the next second factor/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset second factor' }));

    expect(
      await screen.findByText(/Omar Nasser's second factor was reset\. They were signed out/),
    ).toBeInTheDocument();
    const row = await rowFor('omar@helpdock.com');
    await waitFor(() => {
      expect(within(row).getByText('Not set up')).toBeInTheDocument();
    });
  });

  it('says a wrong password back at step 1 and keeps the factors', async () => {
    const { user } = await renderStaff();
    await openReset(user);

    await stepUp(user, 'not the password');
    await user.click(await screen.findByRole('button', { name: 'Reset second factor' }));

    expect(await screen.findByText('That password or code did not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(within(await rowFor('omar@helpdock.com')).getByText('Enrolled')).toBeInTheDocument();
  });

  it('refuses the last break-glass admin with a sentence naming them', async () => {
    const { user } = await renderStaff();
    await openReset(user);

    await stepUp(user, MOCK_RESET_BLOCKED_PASSWORD);
    await user.click(await screen.findByRole('button', { name: 'Reset second factor' }));

    expect(
      await screen.findByText(
        /Omar Nasser is the last install admin who can sign in while SSO is enforced/,
      ),
    ).toBeInTheDocument();
    expect(within(await rowFor('omar@helpdock.com')).getByText('Enrolled')).toBeInTheDocument();
  });
});
