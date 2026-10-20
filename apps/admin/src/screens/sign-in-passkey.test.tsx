import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { AuthError } from '../auth/api.js';
import { MockAuthApi } from '../auth/mock-api.js';
import { PasskeyCeremonyError } from '../auth/passkey-ceremony.js';
import { renderApp } from '../test/render.tsx';

/**
 * `Admin/Login-Passkey` (M18-04). The browser's prompt is replaced, because
 * jsdom has no authenticator: what is proved is which controls the page draws
 * for which answer of `GET /api/auth/methods`, what each outcome says, that
 * the autofill is asked for only where it can run, and that a success is a
 * session with no second step. That the api verifies the signature is its own
 * suite's.
 */

const ceremony = vi.hoisted(() => ({
  assert: vi.fn(),
  supported: true,
  autofill: true,
  cancel: vi.fn(),
}));

vi.mock('../auth/passkey-ceremony.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/passkey-ceremony.js')>()),
  assertPasskey: ceremony.assert,
  passkeysSupported: () => ceremony.supported,
  passkeyAutofillSupported: () => Promise.resolve(ceremony.autofill),
  cancelPasskeyCeremony: ceremony.cancel,
}));

const assertion = {
  id: 'AQID',
  rawId: 'AQID',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
  clientExtensionResults: {},
};

/** The autofill request never settles unless the test settles it, as in a browser nobody touches. */
const pendingAutofill = () => new Promise<never>(() => undefined);

beforeEach(() => {
  ceremony.supported = true;
  ceremony.autofill = true;
  ceremony.cancel.mockReset();
  ceremony.assert.mockReset();
  ceremony.assert.mockImplementation((_options, { autofill = false } = {}) =>
    autofill ? pendingAutofill() : Promise.resolve(assertion),
  );
});

const renderSignIn = async (
  seed: Parameters<MockAuthApi['seedPasskeys']>[0] = { count: 1 },
  configure: (api: MockAuthApi) => void = () => undefined,
) => {
  const api = new MockAuthApi();
  api.seedPasskeys(seed);
  configure(api);
  const rendered = renderApp(<AppRoutes />, { authApi: api, initialEntries: ['/sign-in'] });
  await screen.findByLabelText('Email');
  return { ...rendered, api };
};

const button = () => screen.queryByRole('button', { name: 'Sign in with a passkey' });

describe('the sign-in page offers a passkey', () => {
  it('draws the button after the divider, the hint, and the autofill token on the email field', async () => {
    await renderSignIn();

    expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('autocomplete', 'username webauthn');
    expect(email).toHaveAccessibleDescription(
      'Passkeys stored in this browser are offered here as you type.',
    );
  });

  it('starts the autofill ceremony on load, and ends it when the page goes', async () => {
    const { unmount } = await renderSignIn();

    await waitFor(() => {
      expect(ceremony.assert).toHaveBeenCalledWith(expect.anything(), { autofill: true });
    });
    unmount();
    expect(ceremony.cancel).toHaveBeenCalled();
  });

  it('draws nothing and starts nothing when the api does not offer it', async () => {
    await renderSignIn({ count: 1, state: 'unavailable' });

    await screen.findByRole('button', { name: 'Email me a sign-in link' });
    expect(button()).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(ceremony.assert).not.toHaveBeenCalled();
  });

  it('hides it, and never starts the autofill, under SSO enforcement', async () => {
    await renderSignIn({ count: 1 }, (api) => {
      api.ssoEnforced = true;
    });

    await screen.findByRole('button', { name: /Continue/ });
    expect(button()).not.toBeInTheDocument();
    expect(ceremony.assert).not.toHaveBeenCalled();
  });

  it('replaces the button with a warning when the install’s address moved', async () => {
    await renderSignIn({ count: 1, state: 'paused' });

    expect(await screen.findByText('Passkeys unavailable')).toBeInTheDocument();
    expect(
      screen.getByText(/Passkeys are paused because this install's address changed/),
    ).toBeVisible();
    expect(button()).not.toBeInTheDocument();
    expect(ceremony.assert).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeEnabled();
  });

  it('disables the button with the reason where the browser cannot run a ceremony', async () => {
    ceremony.supported = false;
    ceremony.autofill = false;
    await renderSignIn();

    const disabled = await screen.findByRole('button', { name: 'Sign in with a passkey' });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAccessibleDescription(/This browser can't use passkeys/);
    expect(ceremony.assert).not.toHaveBeenCalled();
  });

  it('does not ask for the autofill list where the browser has none, but keeps the button', async () => {
    ceremony.autofill = false;
    await renderSignIn();

    expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
    expect(ceremony.assert).not.toHaveBeenCalled();
  });
});

describe('signing in with the button', () => {
  it('opens the shell with no second step', async () => {
    const { user } = await renderSignIn();

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    expect(await screen.findByRole('heading', { name: 'My open' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Confirm it's you" })).not.toBeInTheDocument();
  });

  it('shows the prompt state while the browser waits, and Cancel returns to the form with a neutral notice', async () => {
    let settle: (reason: unknown) => void = () => undefined;
    ceremony.assert.mockImplementation((_options, { autofill = false } = {}) =>
      autofill
        ? pendingAutofill()
        : new Promise((_resolve, reject) => {
            settle = reject;
          }),
    );
    const { user } = await renderSignIn();

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    expect(await screen.findByText('Waiting for your passkey…')).toBeInTheDocument();
    expect(screen.getByText(/Follow your browser's prompt/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ceremony.cancel).toHaveBeenCalled();
    settle(new PasskeyCeremonyError('cancelled'));

    const notice = await screen.findByText(
      'Passkey sign-in was cancelled. Try again, or sign in another way.',
    );
    expect(notice.closest('[role="alert"]')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('says a closed prompt is neither a refusal nor an error of the password form', async () => {
    ceremony.assert.mockImplementation((_options, { autofill = false } = {}) =>
      autofill ? pendingAutofill() : Promise.reject(new PasskeyCeremonyError('cancelled')),
    );
    const { user } = await renderSignIn();

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    expect(await screen.findByText(/Passkey sign-in was cancelled/)).toBeInTheDocument();
    expect(screen.queryByText(/We couldn't sign you in/)).not.toBeInTheDocument();
    expect(screen.queryByText('That email and password do not match.')).not.toBeInTheDocument();
  });

  it('gives one message for an unknown, removed or deactivated passkey', async () => {
    const { user } = await renderSignIn({ count: 0 });

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    expect(
      await screen.findByText(
        "We couldn't sign you in with that passkey. It may belong to another site or have been removed from your account. Sign in another way, then check Security › Passkeys.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('says the browser could not use the passkey when the prompt fails for another reason', async () => {
    ceremony.assert.mockImplementation((_options, { autofill = false } = {}) =>
      autofill ? pendingAutofill() : Promise.reject(new PasskeyCeremonyError('failed')),
    );
    const { user } = await renderSignIn();

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    expect(
      await screen.findByText(
        "The browser couldn't use your passkey. Try again, or sign in another way.",
      ),
    ).toBeInTheDocument();
  });

  it('words a rate limit like the password form does', async () => {
    const { user, api } = await renderSignIn();
    vi.spyOn(api, 'signInWithPasskey').mockRejectedValue(
      new AuthError('rate-limited', { retryAfter: 120 }),
    );

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    expect(
      await screen.findByText('Too many sign-in attempts. Try again in 2 minutes.'),
    ).toBeInTheDocument();
  });

  it('swaps the button for the warning when the api says the address moved', async () => {
    const { user, api } = await renderSignIn();
    vi.spyOn(api, 'passkeySignInOptions').mockRejectedValue(new AuthError('passkeys-rp-changed'));

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    expect(await screen.findByText('Passkeys unavailable')).toBeInTheDocument();
    expect(button()).not.toBeInTheDocument();
  });

  it('starts the autofill again once a ceremony the person started has ended', async () => {
    ceremony.assert.mockImplementation((_options, { autofill = false } = {}) =>
      autofill ? pendingAutofill() : Promise.reject(new PasskeyCeremonyError('cancelled')),
    );
    const { user } = await renderSignIn();
    await waitFor(() => {
      expect(ceremony.assert).toHaveBeenCalledTimes(1);
    });

    await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

    await waitFor(() => {
      expect(ceremony.assert.mock.calls.filter(([, options]) => options?.autofill)).toHaveLength(2);
    });
  });
});

describe('signing in from the email field’s autofill', () => {
  it('signs in when the person picks a passkey from the list', async () => {
    ceremony.assert.mockResolvedValue(assertion);

    await renderSignIn();

    expect(await screen.findByRole('heading', { name: 'My open' })).toBeInTheDocument();
  });
});

describe('when the autofill cannot run', () => {
  it('says nothing and does not try again, because nobody asked for it', async () => {
    ceremony.assert.mockImplementation((_options, { autofill = false } = {}) =>
      autofill ? Promise.reject(new PasskeyCeremonyError('failed')) : Promise.resolve(assertion),
    );

    await renderSignIn();

    await screen.findByRole('button', { name: 'Sign in with a passkey' });
    await waitFor(() => {
      expect(ceremony.assert).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/couldn't use your passkey/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('when the autofill request is stopped before anyone chose a passkey', () => {
  it.each([
    ['a rate-limited options call', new AuthError('rate-limited', { retryAfter: 600 })],
    ['an install whose address moved', new AuthError('passkeys-rp-changed')],
    ['an unreachable api', new Error('offline')],
  ])('says nothing for %s', async (_name, error) => {
    const api = new MockAuthApi();
    api.seedPasskeys({ count: 1 });
    vi.spyOn(api, 'passkeySignInOptions').mockRejectedValue(error);
    renderApp(<AppRoutes />, { authApi: api, initialEntries: ['/sign-in'] });

    await screen.findByRole('button', { name: 'Sign in with a passkey' });
    await waitFor(() => {
      expect(api.passkeySignInOptions).toHaveBeenCalled();
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Too many sign-in attempts/)).not.toBeInTheDocument();
    expect(screen.queryByText('Passkeys unavailable')).not.toBeInTheDocument();
  });

  it('still tells the person when the passkey they picked from the list is refused', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ count: 1 });
    vi.spyOn(api, 'signInWithPasskey').mockRejectedValue(new AuthError('invalid-credentials'));
    ceremony.assert.mockResolvedValue(assertion);
    renderApp(<AppRoutes />, { authApi: api, initialEntries: ['/sign-in'] });

    expect(
      await screen.findByText(/We couldn't sign you in with that passkey/),
    ).toBeInTheDocument();
  });
});

describe('an autofill request left open', () => {
  it('is replaced with fresh options before the ceremony behind it expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = new MockAuthApi();
      api.seedPasskeys({ count: 1 });
      const options = vi.spyOn(api, 'passkeySignInOptions');
      renderApp(<AppRoutes />, { authApi: api, initialEntries: ['/sign-in'] });
      await waitFor(() => {
        expect(options).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      expect(options).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(61 * 1000);
      await waitFor(() => {
        expect(options).toHaveBeenCalledTimes(2);
      });
      expect(ceremony.cancel).toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
