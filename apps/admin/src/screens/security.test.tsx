import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
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

  await screen.findByRole('heading', { name: 'Security', level: 1 });

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
