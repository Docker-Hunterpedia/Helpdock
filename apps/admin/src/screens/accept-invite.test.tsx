import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { rememberInviteReturn } from '../auth/invite-return.js';
import { MockAuthApi } from '../auth/mock-api.js';
import {
  MOCK_BREACHED_PASSWORD,
  MOCK_ENROLMENT_CODE,
  MOCK_EXPIRED_INVITE_TOKEN,
  MOCK_INVITE_TOKEN,
  MockStaffApi,
} from '../staff/mock-api.js';
import { renderApp } from '../test/render.tsx';

/**
 * `Admin/AcceptInvite`, the one screen somebody without an account ever sees.
 * Both states matter: the live invitation, and the link that has run out.
 */

const renderInvite = (token: string, authApi?: MockAuthApi) => {
  const staffApi = new MockStaffApi();

  return renderApp(<AppRoutes />, {
    authApi: authApi ?? new MockAuthApi(staffApi),
    staffApi,
    initialEntries: [`/invite/${token}`],
  });
};

describe('a live invitation', () => {
  it('says who invited whom, to what, and for how long', async () => {
    renderInvite(MOCK_INVITE_TOKEN);

    expect(
      await screen.findByText(
        /Lina Haddad invited karim@helpdock.com as Agent in Support\. The link works for \d+ more day/,
      ),
    ).toBeInTheDocument();
  });

  it('warns that two-factor comes next, because this install requires it', async () => {
    renderInvite(MOCK_INVITE_TOKEN);

    expect(
      await screen.findByText(
        "Next you'll set up two-factor authentication, which this install requires.",
      ),
    ).toBeInTheDocument();
  });

  it('asks for a name before it asks the api for anything', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.type(await screen.findByLabelText('Choose a password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
  });

  it('holds the twelve-character floor the api enforces', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.type(await screen.findByLabelText('Your name'), 'Karim Aziz');
    await user.type(screen.getByLabelText('Choose a password'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
  });

  it('judges the password as it is typed, in words as well as in colour', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    const field = await screen.findByLabelText('Choose a password');
    await user.type(field, 'Correct Horse 7 Battery Staple!');

    expect(await screen.findByText(/At least 12 characters\. Strong\./)).toBeInTheDocument();
  });

  it('lands on the second-factor chooser once the account is created', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.type(await screen.findByLabelText('Your name'), 'Karim Aziz');
    await user.type(screen.getByLabelText('Choose a password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByRole('heading', { name: 'Set up a second factor', level: 1 }),
    ).toBeInTheDocument();
  });

  it('enrols with the challenge it was handed, and signs in when that is done', async () => {
    const staffApi = new MockStaffApi();
    const authApi = new MockAuthApi(staffApi);
    const start = vi.spyOn(authApi, 'startEnrolment');
    const complete = vi.spyOn(authApi, 'completeEnrolment');
    const { user } = renderInvite(MOCK_INVITE_TOKEN, authApi);

    await user.type(await screen.findByLabelText('Your name'), 'Karim Aziz');
    await user.type(screen.getByLabelText('Choose a password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await user.click(await screen.findByRole('radio', { name: /Use an authenticator app/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Authentication code'), MOCK_ENROLMENT_CODE);
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }));
    await screen.findByRole('heading', { name: 'Save your recovery codes', level: 1 });

    expect(start).toHaveBeenCalledWith(expect.stringMatching(/^mock-enrol-/));
    expect(complete).toHaveBeenCalledWith(
      expect.stringMatching(/^mock-enrol-/),
      MOCK_ENROLMENT_CODE,
    );
    await expect(authApi.me()).resolves.not.toBeNull();
  });

  it('draws a breached password as the field’s error, not as a banner', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.type(await screen.findByLabelText('Your name'), 'Karim Aziz');
    await user.type(screen.getByLabelText('Choose a password'), MOCK_BREACHED_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This password appears in lists of leaked passwords',
    );
    expect(screen.getByLabelText('Choose a password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('offers both languages, each in its own name', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.click(await screen.findByLabelText('Language'));
    const options = await screen.findAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual(['English', 'العربية']);
  });
});

describe('accepting with a provider (Admin/AcceptInvite-Providers)', () => {
  it('asks for the name before it leaves for the provider', async () => {
    const authApi = new MockAuthApi(new MockStaffApi());
    const start = vi.spyOn(authApi, 'startInviteOauth');
    const { user } = renderInvite(MOCK_INVITE_TOKEN, authApi);

    await user.click(await screen.findByRole('button', { name: 'Google' }));

    expect(await screen.findByText('Enter your name.')).toBeVisible();
    expect(start).not.toHaveBeenCalled();
  });

  it('comes back to say which account answered, and offers the password instead', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.type(await screen.findByLabelText('Your name'), 'Karim Aziz');
    await user.click(screen.getByRole('button', { name: 'GitHub' }));

    expect(
      await screen.findByText(
        /That GitHub account is .*nour\.s@users\.noreply\.github\.com.*, but the invitation is for .*karim@helpdock\.com/,
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText('Choose a password')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Choose a password instead' }));

    expect(screen.getByLabelText('Your name')).toHaveValue('Karim Aziz');
    expect(screen.getByLabelText('Choose a password')).toBeVisible();
  });
});

describe('coming back from the provider', () => {
  const comeBack = (fragment: string) => {
    rememberInviteReturn({ path: `/invite/${MOCK_INVITE_TOKEN}`, name: 'Karim Aziz' });
    const staffApi = new MockStaffApi();
    return renderApp(<AppRoutes />, {
      authApi: new MockAuthApi(staffApi),
      staffApi,
      initialEntries: [`/oauth/callback?error=oauth-invite-mismatch&provider=github#${fragment}`],
    });
  };

  it('names the address that answered when the fragment carries one', async () => {
    comeBack('account=nour%40elsewhere.test');

    expect(await screen.findByText(/That GitHub account is .*nour@elsewhere\.test/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose a password instead' })).toBeVisible();
  });

  it('says it without an address when the fragment carries something else', async () => {
    comeBack('account=%3Cscript%3E');

    expect(
      await screen.findByText(/That GitHub account is not for .*karim@helpdock\.com/),
    ).toBeVisible();
    expect(screen.queryByText(/script/)).not.toBeInTheDocument();
  });
});

describe('an invitation that is no longer valid', () => {
  it('says so, and offers the way back rather than a form', async () => {
    renderInvite(MOCK_EXPIRED_INVITE_TOKEN);

    expect(
      await screen.findByRole('heading', { name: 'This invitation is no longer valid', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose a password')).not.toBeInTheDocument();
  });

  it('tells somebody to ask an administrator, because there is nobody to name', async () => {
    renderInvite(MOCK_EXPIRED_INVITE_TOKEN);

    expect(
      await screen.findByText(
        'This invitation is no longer valid. Ask an administrator to send a new one.',
      ),
    ).toBeInTheDocument();
  });
});
