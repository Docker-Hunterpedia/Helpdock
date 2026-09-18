import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { MOCK_EMAIL, MOCK_PASSWORD, MOCK_RECOVERY_CODE, MOCK_TOTP_CODE } from '../auth/mock-api.js';
import { renderApp } from '../test/render.tsx';

async function reachCodeScreen(): Promise<{ user: UserEvent }> {
  const { user } = renderApp(<AppRoutes />, { initialEntries: ['/sign-in'] });

  await user.type(await screen.findByLabelText('Email'), MOCK_EMAIL);
  await user.type(screen.getByLabelText('Password'), MOCK_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Enter your code' });

  return { user };
}

const verify = () => screen.getByRole('button', { name: 'Verify' });

describe('Totp', () => {
  it('sends the browser back to sign-in when there is no challenge to answer', async () => {
    renderApp(<AppRoutes />, { initialEntries: ['/sign-in/totp'] });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('is a one-time-code field the password manager can fill', async () => {
    await reachCodeScreen();
    const input = screen.getByLabelText('Authentication code');

    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAccessibleDescription('Codes rotate every 30 seconds.');
  });

  it('takes only six digits, so there is no invalid code to report', async () => {
    const { user } = await reachCodeScreen();

    await user.type(screen.getByLabelText('Authentication code'), '12ab3456789');

    expect(screen.getByLabelText('Authentication code')).toHaveValue('123456');
  });

  it('names the account the code belongs to', async () => {
    await reachCodeScreen();

    expect(
      screen.getByText(`Open your authenticator app and enter the 6-digit code for ${MOCK_EMAIL}.`),
    ).toBeInTheDocument();
  });

  it('opens the shell once the code matches', async () => {
    const { user } = await reachCodeScreen();

    await user.type(screen.getByLabelText('Authentication code'), MOCK_TOTP_CODE);
    await user.click(verify());

    expect(await screen.findByRole('heading', { name: 'Tickets' })).toBeInTheDocument();
  });

  it('counts the attempts down and then locks', async () => {
    const { user } = await reachCodeScreen();

    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(verify());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That code didn't match. 2 attempts left before a 15-minute lock.",
    );

    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(verify());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That code didn't match. 1 attempt left before a 15-minute lock.",
    );

    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(verify());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 15 minutes.',
    );
    expect(screen.getByLabelText('Authentication code')).toBeDisabled();
  });

  it('swaps the same card over to a recovery code and back', async () => {
    const { user } = await reachCodeScreen();

    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));

    expect(screen.getByLabelText('Recovery code')).toHaveAttribute('autocomplete', 'off');
    expect(screen.queryByLabelText('Trust this browser for 30 days')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use your authenticator app' }));

    expect(screen.getByLabelText('Authentication code')).toBeInTheDocument();
  });

  it('signs in with a recovery code', async () => {
    const { user } = await reachCodeScreen();

    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), MOCK_RECOVERY_CODE);
    await user.click(verify());

    expect(await screen.findByRole('heading', { name: 'Tickets' })).toBeInTheDocument();
  });
});
