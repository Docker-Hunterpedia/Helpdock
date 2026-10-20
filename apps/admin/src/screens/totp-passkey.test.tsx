import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { AuthError } from '../auth/api.js';
import { MOCK_EMAIL, MOCK_PASSWORD, MOCK_TOTP_CODE, MockAuthApi } from '../auth/mock-api.js';
import { PasskeyCeremonyError } from '../auth/passkey-ceremony.js';
import { renderApp } from '../test/render.tsx';

/**
 * `Admin/SecondFactor` (M18-03). The browser's own prompt is replaced, because
 * jsdom has no authenticator: what is proved here is which factors the screen
 * offers, how each outcome is worded, and that a closed prompt costs nothing.
 * That a passkey, a code and a recovery code share one budget is the api's, and
 * is proved there.
 */

const ceremony = vi.hoisted(() => ({
  assert: vi.fn(),
}));

vi.mock('../auth/passkey-ceremony.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/passkey-ceremony.js')>()),
  assertPasskey: ceremony.assert,
  passkeysSupported: () => true,
}));

const assertion = {
  id: 'AQID',
  rawId: 'AQID',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
  clientExtensionResults: {},
};

beforeEach(() => {
  ceremony.assert.mockReset();
  ceremony.assert.mockResolvedValue(assertion);
});

const reachScreen = async (seed: Parameters<MockAuthApi['seedPasskeys']>[0] = { count: 1 }) => {
  const api = new MockAuthApi();
  api.seedPasskeys(seed);
  const rendered = renderApp(<AppRoutes />, { authApi: api, initialEntries: ['/sign-in'] });

  await rendered.user.type(await screen.findByLabelText('Email'), MOCK_EMAIL);
  await rendered.user.type(screen.getByLabelText('Password'), MOCK_PASSWORD);
  await rendered.user.click(screen.getByRole('button', { name: 'Sign in' }));

  return rendered;
};

const usePasskey = () => screen.getByRole('button', { name: 'Use your passkey' });

describe('an account with a passkey', () => {
  it('offers the passkey first, then the code, and says whose second step it is', async () => {
    await reachScreen();

    expect(await screen.findByRole('heading', { name: "Confirm it's you" })).toBeInTheDocument();
    expect(screen.getByText(`Second step for ${MOCK_EMAIL}.`)).toBeInTheDocument();
    expect(usePasskey()).toBeInTheDocument();
    expect(screen.getByText('or enter a code from your authenticator app')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a recovery code' })).toBeInTheDocument();
  });

  it('opens the shell once the passkey answers', async () => {
    const { user } = await reachScreen();
    await screen.findByRole('heading', { name: "Confirm it's you" });

    await user.click(usePasskey());

    expect(await screen.findByRole('heading', { name: 'My open' })).toBeInTheDocument();
  });

  it('also takes the code, which stays an option beside the passkey', async () => {
    const { user } = await reachScreen();
    await screen.findByRole('heading', { name: "Confirm it's you" });

    await user.type(screen.getByLabelText('Authentication code'), MOCK_TOTP_CODE);
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    expect(await screen.findByRole('heading', { name: 'My open' })).toBeInTheDocument();
  });

  it('says a closed prompt is not a failure, and leaves the attempts as they were', async () => {
    ceremony.assert.mockRejectedValueOnce(new PasskeyCeremonyError('cancelled'));
    const { user } = await reachScreen();
    await screen.findByRole('heading', { name: "Confirm it's you" });

    await user.click(usePasskey());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The passkey prompt was closed. Nothing was counted against you.',
    );
    // The next try is still the first of three.
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('2 attempts left');
  });

  it('counts a passkey the api refuses, with the lock after the third try', async () => {
    const { user } = await reachScreen();
    await screen.findByRole('heading', { name: "Confirm it's you" });
    ceremony.assert.mockResolvedValue({ ...assertion, rawId: 'unknown' });
    const refuse = vi
      .spyOn(MockAuthApi.prototype, 'verifyPasskey')
      .mockRejectedValueOnce(new AuthError('passkey-invalid', { attemptsLeft: 2 }))
      .mockRejectedValueOnce(new AuthError('passkey-invalid', { attemptsLeft: 1 }))
      .mockRejectedValueOnce(new AuthError('totp-locked'));

    await user.click(usePasskey());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That didn't work. 2 attempts left before a 15-minute lock.",
    );
    await user.click(usePasskey());
    expect(await screen.findByText(/1 attempt left before a 15-minute lock/)).toBeInTheDocument();
    await user.click(usePasskey());
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
    expect(usePasskey()).toBeDisabled();

    refuse.mockRestore();
  });

  it('explains a browser that cannot use passkeys here and keeps the other ways', async () => {
    ceremony.assert.mockRejectedValueOnce(new PasskeyCeremonyError('unsupported'));
    const { user } = await reachScreen();
    await screen.findByRole('heading', { name: "Confirm it's you" });

    await user.click(usePasskey());

    expect(await screen.findByRole('alert')).toHaveTextContent("This browser can't use passkeys");
    expect(screen.getByLabelText('Authentication code')).toBeEnabled();
  });

  it('says passkeys are paused when the install moved, instead of a lock', async () => {
    const { user } = await reachScreen();
    await screen.findByRole('heading', { name: "Confirm it's you" });
    vi.spyOn(MockAuthApi.prototype, 'passkeySecondFactorOptions').mockRejectedValueOnce(
      new AuthError('passkeys-rp-changed'),
    );

    await user.click(usePasskey());

    expect(await screen.findByRole('alert')).toHaveTextContent('Passkeys are paused');
    expect(usePasskey()).toBeEnabled();
  });
});

describe('an account whose only second factor is a passkey', () => {
  it('shows no code field and offers the recovery code as the other way', async () => {
    await reachScreen({ count: 1, noApp: true });
    await screen.findByRole('heading', { name: "Confirm it's you" });

    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify code' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Trust this browser for 30 days')).toBeInTheDocument();
  });

  it('swaps to the recovery code and back to the passkey', async () => {
    const { user } = await reachScreen({ count: 1, noApp: true });
    await screen.findByRole('heading', { name: "Confirm it's you" });

    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    expect(screen.getByLabelText('Recovery code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use your passkey' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use your passkey' }));
    expect(screen.queryByLabelText('Recovery code')).not.toBeInTheDocument();
  });
});

describe('an account with an authenticator app alone', () => {
  it('sees the screen it always saw', async () => {
    await reachScreen({ count: 0 });

    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use your passkey' })).not.toBeInTheDocument();
  });
});
