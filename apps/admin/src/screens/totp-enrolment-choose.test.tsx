import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { AuthError } from '../auth/api.js';
import { MockAuthApi } from '../auth/mock-api.js';
import { PasskeyCeremonyError } from '../auth/passkey-ceremony.js';
import { MOCK_TOTP_SECRET } from '../staff/mock-api.js';
import { renderApp } from '../test/render.tsx';

/**
 * `Admin/Enrol2FA-Choose` (M18-03): the chooser an enrolment challenge opens
 * with, the passkey path behind it, and the cases where the passkey card must
 * be switched off. The browser's prompt is replaced; jsdom has no authenticator.
 */

const ceremony = vi.hoisted(() => ({ create: vi.fn(), supported: true }));

vi.mock('../auth/passkey-ceremony.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/passkey-ceremony.js')>()),
  createPasskey: ceremony.create,
  passkeysSupported: () => ceremony.supported,
}));

const registration = {
  id: 'AQID',
  rawId: 'AQID',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
  clientExtensionResults: {},
};

beforeEach(() => {
  ceremony.supported = true;
  ceremony.create.mockReset();
  ceremony.create.mockResolvedValue(registration);
});

/** The way an SSO or OAuth callback hands an enrolment challenge to the app. */
const renderChooser = (api = new MockAuthApi()) =>
  renderApp(<AppRoutes />, {
    authApi: api,
    initialEntries: ['/sign-in/complete?enrol=mock-enrol-1'],
  });

const choosePasskey = () => screen.getByRole('radio', { name: /Add a passkey/ });
const chooseApp = () => screen.getByRole('radio', { name: /Use an authenticator app/ });
const next = () => screen.getByRole('button', { name: 'Continue' });

describe('the chooser', () => {
  it('offers the passkey first, marked recommended and selected, and the app second', async () => {
    renderChooser();

    expect(
      await screen.findByRole('heading', { name: 'Set up a second factor', level: 1 }),
    ).toBeInTheDocument();
    expect(choosePasskey()).toBeChecked();
    expect(chooseApp()).not.toBeChecked();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
  });

  it('goes to the QR step when the app is chosen, without touching the browser prompt', async () => {
    const { user } = renderChooser();
    await screen.findByRole('heading', { name: 'Set up a second factor' });

    await user.click(chooseApp());
    await user.click(next());

    expect(await screen.findByText(MOCK_TOTP_SECRET)).toBeInTheDocument();
    expect(ceremony.create).not.toHaveBeenCalled();
  });

  it('disables the passkey card with the reason, and selects the app, in a browser that cannot', async () => {
    ceremony.supported = false;
    renderChooser();
    await screen.findByRole('heading', { name: 'Set up a second factor' });

    expect(choosePasskey()).toBeDisabled();
    expect(choosePasskey()).toHaveAccessibleDescription("This browser can't create passkeys here.");
    expect(chooseApp()).toBeChecked();
  });

  it('does the same where the install has paused passkeys', async () => {
    const api = new MockAuthApi();
    vi.spyOn(api, 'authMethods').mockResolvedValue({
      sso: [],
      ssoEnforced: false,
      password: true,
      magicLink: true,
      oauth: { google: false, github: false, microsoft: false },
      passkey: false,
      passkeysPaused: true,
    });
    renderChooser(api);
    await screen.findByRole('heading', { name: 'Set up a second factor' });

    await vi.waitFor(() => {
      expect(choosePasskey()).toBeDisabled();
    });
    expect(choosePasskey()).toHaveAccessibleDescription(
      "Passkeys aren't available on this install right now.",
    );
    expect(chooseApp()).toBeChecked();
  });

  it('returns to the chooser with a neutral notice when the prompt is closed', async () => {
    ceremony.create.mockRejectedValueOnce(new PasskeyCeremonyError('cancelled'));
    const { user } = renderChooser();
    await screen.findByRole('heading', { name: 'Set up a second factor' });

    await user.click(next());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The passkey prompt was closed. Nothing was saved.',
    );
    expect(screen.getByRole('heading', { name: 'Set up a second factor' })).toBeInTheDocument();
  });

  it('says so when this authenticator is already a passkey on the account', async () => {
    ceremony.create.mockRejectedValueOnce(new PasskeyCeremonyError('duplicate'));
    const { user } = renderChooser();
    await screen.findByRole('heading', { name: 'Set up a second factor' });

    await user.click(next());

    expect(await screen.findByRole('alert')).toHaveTextContent('already a passkey');
  });

  it('says the install has paused passkeys when the api refuses to start', async () => {
    const api = new MockAuthApi();
    vi.spyOn(api, 'startPasskeyEnrolment').mockRejectedValueOnce(
      new AuthError('passkeys-rp-changed'),
    );
    const { user } = renderChooser(api);
    await screen.findByRole('heading', { name: 'Set up a second factor' });

    await user.click(next());

    expect(await screen.findByRole('alert')).toHaveTextContent("Passkeys aren't available");
  });
});

describe('the passkey path', () => {
  const reachName = async (api = new MockAuthApi()) => {
    const rendered = renderChooser(api);
    await screen.findByRole('heading', { name: 'Set up a second factor' });
    await rendered.user.click(next());
    await screen.findByRole('heading', { name: 'Name this passkey', level: 1 });
    return rendered;
  };

  it('names the passkey, suggests a name and saves nothing until Continue', async () => {
    const api = new MockAuthApi();
    const finish = vi.spyOn(api, 'completePasskeyEnrolment');
    await reachName(api);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toMatch(
      /passkey$|Security key/,
    );
    expect(screen.getByText(/Passkey added\./)).toBeInTheDocument();
    expect(screen.getByText('Up to 64 characters. You can rename it later.')).toBeInTheDocument();
    expect(finish).not.toHaveBeenCalled();
  });

  it('shows the recovery codes once the passkey is saved, and the shell after them', async () => {
    const { user } = await reachName();

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Desk key');
    await user.click(screen.getByRole('button', { name: 'Continue to recovery codes' }));

    await screen.findByRole('heading', { name: 'Save your recovery codes', level: 1 });
    expect(
      screen.getByText('A passkey is your second factor for lina@helpdock.com'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Recovery codes' })).getAllByRole('listitem'),
    ).toHaveLength(10);
    await user.click(screen.getByLabelText('I have saved these codes somewhere safe'));
    await user.click(screen.getByRole('button', { name: 'Continue to Helpdock' }));
    expect(await screen.findByRole('heading', { name: 'My open' })).toBeInTheDocument();
  });

  it('asks for a name before it asks the api', async () => {
    const { user } = await reachName();

    await user.clear(screen.getByLabelText('Name'));
    await user.click(screen.getByRole('button', { name: 'Continue to recovery codes' }));

    expect(await screen.findByText('Enter a name.')).toBeInTheDocument();
  });

  it.each([
    [
      new AuthError('passkey-invalid', { attemptsLeft: 2 }),
      '2 attempts left before a 15-minute lock',
    ],
    [new AuthError('totp-locked'), 'Too many attempts'],
    [new AuthError('challenge-expired'), 'That took too long'],
  ])('says what went wrong when the api refuses (%o)', async (refusal, said) => {
    const api = new MockAuthApi();
    vi.spyOn(api, 'completePasskeyEnrolment').mockRejectedValueOnce(refusal);
    const { user } = await reachName(api);

    await user.click(screen.getByRole('button', { name: 'Continue to recovery codes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(said);
    expect(screen.getByRole('heading', { name: 'Name this passkey' })).toBeInTheDocument();
  });
});
