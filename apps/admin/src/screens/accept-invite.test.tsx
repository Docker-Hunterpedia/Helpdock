import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { MockAuthApi } from '../auth/mock-api.js';
import { MOCK_EXPIRED_INVITE_TOKEN, MOCK_INVITE_TOKEN, MockStaffApi } from '../staff/mock-api.js';
import { renderApp } from '../test/render.tsx';

/**
 * `Admin/AcceptInvite`, the one screen somebody without an account ever sees.
 * Both states matter: the live invitation, and the link that has run out.
 */

const renderInvite = (token: string) => {
  const staffApi = new MockStaffApi();

  return renderApp(<AppRoutes />, {
    authApi: new MockAuthApi(staffApi),
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

  it('lands on two-factor enrolment once the account is created', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.type(await screen.findByLabelText('Your name'), 'Karim Aziz');
    await user.type(screen.getByLabelText('Choose a password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByRole('heading', { name: 'Turn on two-factor', level: 1 }),
    ).toBeInTheDocument();
  });

  it('offers both languages, each in its own name', async () => {
    const { user } = renderInvite(MOCK_INVITE_TOKEN);

    await user.click(await screen.findByLabelText('Language'));
    const options = await screen.findAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual(['English', 'العربية']);
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
