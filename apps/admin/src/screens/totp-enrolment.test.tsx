import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { MOCK_ENROLMENT_CODE, MOCK_TOTP_SECRET } from '../staff/mock-api.js';
import { renderApp } from '../test/render.tsx';

/**
 * `Admin/Enrol2FA`. The two things worth proving are the order — nothing is
 * enabled until a live code confirms it — and the gate on the recovery codes,
 * because the button that skips them is the one that generates the support
 * ticket nobody can answer.
 */

const renderEnrolment = () => renderApp(<AppRoutes />, { initialEntries: ['/sign-in/enrol'] });

const reachStepTwo = async () => {
  const rendered = renderEnrolment();

  await screen.findByText(MOCK_TOTP_SECRET);
  await rendered.user.type(screen.getByLabelText('Authentication code'), MOCK_ENROLMENT_CODE);
  await rendered.user.click(screen.getByRole('button', { name: 'Turn on two-factor' }));
  await screen.findByRole('heading', { name: 'Save your recovery codes', level: 1 });

  return rendered;
};

describe('step one', () => {
  it('draws the code as an image with a name a screen reader can read', async () => {
    renderEnrolment();

    expect(
      await screen.findByRole('img', { name: 'QR code for setting up an authenticator app' }),
    ).toBeInTheDocument();
  });

  it('offers the key in text for somebody who cannot point a camera at the screen', async () => {
    renderEnrolment();

    expect(await screen.findByText(MOCK_TOTP_SECRET)).toBeInTheDocument();
    expect(screen.getByText("Can't scan? Enter this key")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeInTheDocument();
  });

  it('names the account and the issuer the key belongs to', async () => {
    renderEnrolment();

    expect(
      await screen.findByText('Account: lina@helpdock.com · Issuer: Helpdock'),
    ).toBeInTheDocument();
  });

  it('asks for six digits before it asks the api', async () => {
    const { user } = renderEnrolment();

    await screen.findByText(MOCK_TOTP_SECRET);
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }));

    expect(
      await screen.findByText('Enter the 6-digit code from your authenticator app.'),
    ).toBeInTheDocument();
  });

  it('says so when the code does not match, and stays on this step', async () => {
    const { user } = renderEnrolment();

    await screen.findByText(MOCK_TOTP_SECRET);
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }));

    expect(await screen.findByText('That code did not match.')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Turn on two-factor', level: 1 }),
    ).toBeInTheDocument();
  });

  it('takes only digits, and only six of them', async () => {
    const { user } = renderEnrolment();

    await screen.findByText(MOCK_TOTP_SECRET);
    const field = screen.getByLabelText('Authentication code');
    await user.type(field, 'a1b2c3d4e5');

    expect(field).toHaveValue('12345');
  });

  it('offers a way out that is not "keep trying"', async () => {
    renderEnrolment();

    expect(await screen.findByRole('button', { name: 'Sign out instead' })).toBeInTheDocument();
  });
});

describe('step two', () => {
  it('shows ten recovery codes, once', async () => {
    await reachStepTwo();
    const list = screen.getByRole('list', { name: 'Recovery codes' });

    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  });

  it('confirms the second factor is on, and for whom', async () => {
    await reachStepTwo();

    expect(screen.getByText('Two-factor is on for lina@helpdock.com')).toBeInTheDocument();
  });

  /**
   * The gate is the point of this screen: somebody who clicks past their
   * recovery codes has no way back into the account if they lose the phone.
   */
  it('keeps Continue disabled until the codes are acknowledged', async () => {
    const { user } = await reachStepTwo();
    const button = screen.getByRole('button', { name: 'Continue to Helpdock' });

    expect(button).toBeDisabled();

    await user.click(screen.getByLabelText('I have saved these codes somewhere safe'));

    expect(button).toBeEnabled();
  });

  it('offers both a download and a copy', async () => {
    await reachStepTwo();

    expect(screen.getByRole('button', { name: 'Download .txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy all' })).toBeInTheDocument();
  });
});
