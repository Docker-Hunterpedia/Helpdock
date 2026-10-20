import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { MOCK_TOTP_CODE, type MockAuthApi } from '../auth/mock-api.js';
import { MOCK_CURRENT_PASSWORD, MOCK_ENROLMENT_CODE } from '../staff/mock-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';

/**
 * `/me/security`. Everything here weakens or replaces a credential, so what is
 * asserted is that each one asks for a credential of its own first.
 */

const renderSecurity = async () => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    initialEntries: ['/me/security'],
  });

  await screen.findByRole('heading', { name: 'Your account', level: 1 });

  return rendered;
};

describe('your details', () => {
  it('shows the account and leaves the address to an administrator', async () => {
    await renderSecurity();

    expect(await screen.findByLabelText('Name')).toHaveValue('Lina Haddad');
    // Read-only rather than disabled, so the address stays selectable and legible.
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
  });

  it('saves a new name', async () => {
    const { user } = await renderSecurity();

    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Lina H.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });
});

describe('the password card', () => {
  it('asks for the current password before anything else', async () => {
    const { user } = await renderSecurity();

    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Enter your current password.')).toBeInTheDocument();
  });

  it('holds the twelve-character floor for the new one', async () => {
    const { user } = await renderSecurity();

    await user.type(screen.getByLabelText('Current password'), MOCK_CURRENT_PASSWORD);
    await user.type(screen.getByLabelText('New password'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
  });

  it('says so when the current password is wrong', async () => {
    const { user } = await renderSecurity();

    await user.type(screen.getByLabelText('Current password'), 'not the password');
    await user.type(screen.getByLabelText('New password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('That current password is not right.')).toBeInTheDocument();
  });

  it('changes it, and says the other browsers were signed out', async () => {
    const { user } = await renderSecurity();

    await user.type(screen.getByLabelText('Current password'), MOCK_CURRENT_PASSWORD);
    await user.type(screen.getByLabelText('New password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(
      await screen.findByText('Your password was changed. Every other browser was signed out.'),
    ).toBeInTheDocument();
  });
});

describe('the two-factor card', () => {
  it('says it is on and how many recovery codes are left', async () => {
    await renderSecurity();

    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText('8 recovery codes left.')).toBeInTheDocument();
  });

  it('asks for a live code before turning it off', async () => {
    const { user } = await renderSecurity();

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Turn off two-factor?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }));
    expect(
      await screen.findByText('Enter the 6-digit code from your authenticator app.'),
    ).toBeInTheDocument();
  });

  it('turns it off once a live code is given', async () => {
    const { user } = await renderSecurity();

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    await user.type(await screen.findByLabelText('Authentication code'), MOCK_ENROLMENT_CODE);
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }));

    expect(await screen.findByText('Two-factor is off for this account.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Turn on two-factor' })).toBeInTheDocument();
  });

  it('redraws the recovery codes and shows the new ones once', async () => {
    const { user } = await renderSecurity();

    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await user.type(await screen.findByLabelText('Authentication code'), MOCK_ENROLMENT_CODE);
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(
      await screen.findByText('New recovery codes. The old ones no longer work.'),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  });

  it('refuses a code that does not match', async () => {
    const { user } = await renderSecurity();

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    await user.type(await screen.findByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }));

    expect(await screen.findByText('That code did not match.')).toBeInTheDocument();
  });
});

describe('the sessions card', () => {
  it('lists the browsers and marks the one being used', async () => {
    await renderSecurity();
    const list = await screen.findByRole('list', {
      name: 'Browsers this account is signed in on',
    });

    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText(/This browser/)).toBeInTheDocument();
  });

  it('signs one browser out', async () => {
    const { user } = await renderSecurity();
    const list = await screen.findByRole('list', {
      name: 'Browsers this account is signed in on',
    });

    await user.click(
      within(list).getByRole('button', {
        name: 'Sign out Mozilla/5.0 (iPhone) Safari/26',
      }),
    );

    expect(await screen.findByText('That browser was signed out.')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    });
  });

  it('offers signing out everywhere, which ends this session too', async () => {
    const { user } = await renderSecurity();

    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

    expect(await screen.findByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument();
  });
});

describe('the sign-in providers card (Admin/Me-SignInProviders)', () => {
  const renderWith = async (prepare: (auth: MockAuthApi) => Promise<void> = async () => {}) => {
    const apis = await signedInMockApis();
    const auth = apis.auth as MockAuthApi;
    await prepare(auth);
    const rendered = renderApp(<AppRoutes />, {
      authApi: auth,
      staffApi: apis.staff,
      initialEntries: ['/me/security'],
    });
    await screen.findByRole('heading', { name: 'Active sessions', level: 2 });

    return { ...rendered, auth };
  };

  it('explains the 1.0.1 change while nothing is linked, and connects after a step-up', async () => {
    const { user } = await renderWith();
    const card = await screen.findByRole('region', { name: 'Sign-in methods' });

    expect(within(card).getByRole('status')).toHaveTextContent(/Since 1\.0\.1/);
    await user.click(within(card).getByRole('button', { name: 'Connect GitHub' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Password or 6-digit code'), MOCK_TOTP_CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('GitHub is connected. You can sign in with it now.'),
    ).toBeInTheDocument();
    expect(
      await within(card).findByRole('button', { name: 'Disconnect GitHub' }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/not used to sign in yet/)).toBeInTheDocument();
    expect(within(card).queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so in the field when the password is wrong', async () => {
    const { user } = await renderWith();

    await user.click(await screen.findByRole('button', { name: 'Connect Google' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Password or 6-digit code'), 'not the password');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(
      await within(dialog).findByText('That password or code did not match.'),
    ).toBeInTheDocument();
  });

  it('will not disconnect the last way in of an account with no password', async () => {
    await renderWith(async (auth) => {
      await auth.connectOauth('google', { currentPassword: MOCK_CURRENT_PASSWORD });
      auth.passwordSet = false;
    });

    const disconnect = await screen.findByRole('button', { name: 'Disconnect Google' });

    expect(disconnect).toBeDisabled();
    expect(disconnect).toHaveAccessibleDescription(
      'Google is your only way to sign in. Set a password or connect another provider before you disconnect it.',
    );
  });

  it('is not drawn when the install has no provider configured', async () => {
    let asked: ReturnType<typeof vi.spyOn> | undefined;
    await renderWith(async (auth) => {
      const methods = await auth.authMethods();
      asked = vi.spyOn(auth, 'authMethods').mockResolvedValue({
        ...methods,
        oauth: { google: false, github: false },
      });
    });

    // Both answers are in before the card is judged absent.
    await waitFor(() => {
      expect(asked).toHaveBeenCalled();
    });
    await act(async () => {
      await asked?.mock.results[0]?.value;
    });
    expect(screen.queryByRole('heading', { name: 'Sign-in methods' })).not.toBeInTheDocument();
  });
});
