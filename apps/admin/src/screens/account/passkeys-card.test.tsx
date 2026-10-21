import type { RegistrationResponse } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import {
  MOCK_PASSWORD,
  MOCK_TOTP_CODE,
  type MockAuthApi,
  type SeededPasskeys,
} from '../../auth/mock-api.js';
import { PasskeyCeremonyError } from '../../auth/passkey-ceremony.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * The passkeys card on `/me/security` (M18-02, `Admin/Profile-Security-Passkeys`).
 * The browser's ceremony is replaced: jsdom has no authenticator, and what is
 * under test here is what the card does with each answer.
 */

const ceremony = vi.hoisted(() => ({
  supported: true,
  create: vi.fn(),
  assert: vi.fn(),
}));

vi.mock('../../auth/passkey-ceremony.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/passkey-ceremony.js')>()),
  passkeysSupported: () => ceremony.supported,
  createPasskey: ceremony.create,
  assertPasskey: ceremony.assert,
}));

const registration = (id: string): RegistrationResponse => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
  clientExtensionResults: {},
});

beforeEach(() => {
  ceremony.supported = true;
  ceremony.create.mockReset();
  ceremony.create.mockResolvedValue(registration('AQID'));
  ceremony.assert.mockReset();
});

const renderWith = async (
  seed: SeededPasskeys = {},
  prepare: (auth: MockAuthApi) => Promise<void> = async () => {},
) => {
  const apis = await signedInMockApis();
  (apis.auth as MockAuthApi).seedPasskeys(seed);
  await prepare(apis.auth as MockAuthApi);
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    initialEntries: ['/me/security'],
  });
  await screen.findByRole('heading', { name: 'Active sessions', level: 2 });

  return { ...rendered, auth: apis.auth as MockAuthApi };
};

const card = () => screen.findByRole('region', { name: 'Passkeys' });

describe('the list', () => {
  it('shows each passkey with its dates and a Synced chip for a backed-up one', async () => {
    await renderWith({ count: 2 });
    const region = await card();

    const rows = within(region).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('MacBook Air · Touch ID')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('Synced')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText('Synced')).not.toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText(/never used/)).toBeInTheDocument();
    expect(within(region).getByText(/2 of 10 passkeys\./)).toBeInTheDocument();
  });

  it('names the passkey in the label of each action', async () => {
    await renderWith({ count: 1 });
    const region = await card();

    expect(
      within(region).getByRole('button', { name: 'Rename MacBook Air · Touch ID' }),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole('button', { name: 'Remove MacBook Air · Touch ID' }),
    ).toBeInTheDocument();
  });

  it('keeps Add in the header and says there is nothing yet when empty', async () => {
    await renderWith();
    const region = await card();

    expect(within(region).getByText('No passkeys yet')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
  });

  it('is not drawn where passkeys cannot exist', async () => {
    await renderWith({ state: 'unavailable' });

    expect(screen.queryByRole('region', { name: 'Passkeys' })).not.toBeInTheDocument();
  });

  it('turns Add off but leaves Remove while the install’s address has moved', async () => {
    await renderWith({ count: 2, state: 'paused' });
    const region = await card();

    expect(within(region).getByRole('status')).toHaveTextContent(/Passkeys are paused/);
    expect(within(region).getByRole('button', { name: 'Add a passkey' })).toBeDisabled();
    expect(within(region).getByRole('button', { name: 'Remove YubiKey 1' })).toBeEnabled();
  });

  it('turns Add off, and says why, in a browser without WebAuthn', async () => {
    ceremony.supported = false;
    await renderWith();
    const region = await card();

    expect(within(region).getByRole('button', { name: 'Add a passkey' })).toBeDisabled();
    expect(within(region).getByText("This browser can't create passkeys.")).toBeInTheDocument();
  });

  it('disables Remove, and says why, for the only second factor of an account that needs one', async () => {
    await renderWith({ count: 1, onlyFactor: true });
    const region = await card();

    const remove = within(region).getByRole('button', { name: /^Remove / });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(/You can't remove your only second factor/);
  });
});

describe('adding', () => {
  it('asks for the password, waits for the browser, names the passkey and lists it', async () => {
    const { user } = await renderWith();
    const region = await card();

    await user.click(within(region).getByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    const naming = await screen.findByRole('dialog', { name: 'Name this passkey' });
    expect(ceremony.create).toHaveBeenCalledOnce();
    const field = within(naming).getByLabelText('Name');
    expect(field).toHaveValue('Passkey 1');
    await user.clear(field);
    await user.type(field, 'Work laptop');
    await user.click(within(naming).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Passkey added.')).toBeInTheDocument();
    expect(await within(region).findByText('Work laptop')).toBeInTheDocument();
  });

  it('accepts a live code as the proof', async () => {
    const { user } = await renderWith();

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_TOTP_CODE);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('dialog', { name: 'Name this passkey' })).toBeInTheDocument();
  });

  it('says so in the field when the proof is wrong, and starts no ceremony', async () => {
    const { user } = await renderWith();

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), 'not the password');
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    expect(
      await within(stepUp).findByText('That password or code did not match.'),
    ).toBeInTheDocument();
    expect(ceremony.create).not.toHaveBeenCalled();
  });

  it('asks for something before it continues', async () => {
    const { user } = await renderWith();

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    expect(
      await within(stepUp).findByText('Enter your password or a 6-digit code.'),
    ).toBeInTheDocument();
  });

  it('says the account is locked once the step-up budget is spent', async () => {
    const { user } = await renderWith();
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    const field = within(stepUp).getByLabelText('Password or 6-digit code');

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await user.clear(field);
      await user.type(field, 'not the password');
      await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));
      await within(stepUp).findByText(/did not match|Too many tries/);
    }

    expect(
      await within(stepUp).findByText('Too many tries. Wait a few minutes, then try again.'),
    ).toBeInTheDocument();
  });

  it('offers to try again when the prompt was cancelled, and adds nothing', async () => {
    ceremony.create.mockRejectedValueOnce(new PasskeyCeremonyError('cancelled'));
    const { user } = await renderWith();

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    const waiting = await screen.findByRole('dialog', { name: 'Add a passkey' });
    expect(
      await within(waiting).findByText('Adding the passkey was cancelled. Nothing was changed.'),
    ).toBeInTheDocument();

    await user.click(within(waiting).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Name this passkey' })).toBeInTheDocument();
    expect(ceremony.create).toHaveBeenCalledTimes(2);
  });

  it('says an authenticator that is already registered is, without a retry', async () => {
    ceremony.create.mockRejectedValueOnce(new PasskeyCeremonyError('duplicate'));
    const { user } = await renderWith();

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    const waiting = await screen.findByRole('dialog', { name: 'Add a passkey' });
    expect(
      await within(waiting).findByText('This authenticator is already a passkey on your account.'),
    ).toBeInTheDocument();
    expect(within(waiting).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('does not reopen the prompt when Cancel closes it while the browser is still asking', async () => {
    let reject: (reason: unknown) => void = () => {};
    ceremony.create.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const { user } = await renderWith();

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));
    const waiting = await screen.findByRole('dialog', { name: 'Add a passkey' });
    await user.click(within(waiting).getByRole('button', { name: 'Cancel' }));
    reject(new PasskeyCeremonyError('cancelled'));

    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows the limit dialog instead of the prompt at ten', async () => {
    const { user } = await renderWith({ count: 10 });

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));

    const dialog = await screen.findByRole('dialog', { name: 'You have 10 passkeys' });
    expect(within(dialog).getByText(/That's the most one account can hold/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: "Confirm it's you" })).not.toBeInTheDocument();
  });

  it('answers the step-up with a passkey the account already holds', async () => {
    ceremony.assert.mockResolvedValue({
      id: 'AQID',
      rawId: 'AQID',
      type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: {},
    });
    // The fixture only offers a passkey an authenticator made, so one is added first.
    const { user } = await renderWith({}, async (auth) => {
      const { ceremonyId } = await auth.beginPasskey({ currentPassword: MOCK_PASSWORD });
      await auth.finishPasskey({ ceremonyId, response: registration('AQID'), name: 'Held' });
    });

    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.click(within(stepUp).getByRole('button', { name: 'Use your passkey' }));

    expect(await screen.findByRole('dialog', { name: 'Name this passkey' })).toBeInTheDocument();
    expect(ceremony.assert).toHaveBeenCalledOnce();
  });
});

describe('renaming', () => {
  it('asks for the proof first, then renames', async () => {
    const { user } = await renderWith({ count: 2 });
    const region = await card();

    await user.click(within(region).getByRole('button', { name: 'Rename YubiKey 1' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(within(stepUp).getByText(/to rename “YubiKey 1”/)).toBeInTheDocument();
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    const rename = await screen.findByRole('dialog', { name: 'Rename passkey' });
    const field = within(rename).getByLabelText('Name');
    expect(field).toHaveValue('YubiKey 1');
    await user.clear(field);
    await user.type(field, 'Desk key');
    await user.click(within(rename).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Passkey renamed.')).toBeInTheDocument();
    expect(await within(region).findByText('Desk key')).toBeInTheDocument();
  });

  it('refuses an empty name without calling the api', async () => {
    const { user, auth } = await renderWith({ count: 2 });
    const rename = vi.spyOn(auth, 'renamePasskey');
    const region = await card();

    await user.click(within(region).getByRole('button', { name: 'Rename YubiKey 1' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename passkey' });
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(rename).not.toHaveBeenCalled();
  });

  it('goes back to the proof, saying so, when the password turns out wrong', async () => {
    const { user } = await renderWith({ count: 2 });
    const region = await card();

    await user.click(within(region).getByRole('button', { name: 'Rename YubiKey 1' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), 'not the password');
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename passkey' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    const again = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(
      await within(again).findByText('That password or code did not match.'),
    ).toBeInTheDocument();
  });
});

describe('removing', () => {
  it('names the passkey and what still protects the account, then removes it', async () => {
    const { user } = await renderWith({ count: 2 });
    const region = await card();

    await user.click(within(region).getByRole('button', { name: 'Remove YubiKey 1' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    const confirm = await screen.findByRole('dialog', { name: 'Remove “YubiKey 1”?' });
    expect(
      within(confirm).getByText('You still have 1 passkey and an authenticator app.'),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove passkey' }));

    expect(await screen.findByText('Passkey removed.')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(within(region).queryByText('YubiKey 1')).not.toBeInTheDocument();
    });
  });

  it('says what is left when an authenticator app is not', async () => {
    const { user } = await renderWith({ count: 3, onlyFactor: true });
    const region = await card();

    await user.click(within(region).getByRole('button', { name: 'Remove YubiKey 2' }));
    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await user.type(within(stepUp).getByLabelText('Password or 6-digit code'), MOCK_PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: 'Continue' }));

    const confirm = await screen.findByRole('dialog', { name: 'Remove “YubiKey 2”?' });
    expect(within(confirm).getByText('You still have 2 passkeys.')).toBeInTheDocument();
  });
});

describe('redrawing the recovery codes with a passkey', () => {
  const assertion = {
    id: 'AQID',
    rawId: 'AQID',
    type: 'public-key',
    response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
    clientExtensionResults: {},
  };

  it('is not offered to an account without a passkey', async () => {
    await renderWith({});

    expect(
      screen.queryByRole('button', { name: 'Regenerate with a passkey' }),
    ).not.toBeInTheDocument();
  });

  it('is not offered where the browser has no passkey support', async () => {
    ceremony.supported = false;
    await renderWith({ count: 1 });

    expect(
      screen.queryByRole('button', { name: 'Regenerate with a passkey' }),
    ).not.toBeInTheDocument();
  });

  it('asks the browser for a passkey, then shows the new codes once', async () => {
    ceremony.assert.mockResolvedValue(assertion);
    const { user } = await renderWith({ count: 1 });

    await user.click(await screen.findByRole('button', { name: 'Regenerate with a passkey' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Regenerate recovery codes with a passkey?',
    });
    expect(ceremony.assert).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Use my passkey' }));

    expect(await screen.findByText('Your new recovery codes')).toBeInTheDocument();
    expect(ceremony.assert).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('says nothing when the browser prompt is closed, and shows no codes', async () => {
    ceremony.assert.mockRejectedValue(new PasskeyCeremonyError('cancelled'));
    const { user } = await renderWith({ count: 1 });

    await user.click(await screen.findByRole('button', { name: 'Regenerate with a passkey' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Regenerate recovery codes with a passkey?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Use my passkey' }));

    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Your new recovery codes')).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't confirm with your passkey/)).not.toBeInTheDocument();
  });

  it('says so when the passkey could not be confirmed, and shows no codes', async () => {
    ceremony.assert.mockRejectedValue(new PasskeyCeremonyError('failed'));
    const { user } = await renderWith({ count: 1 });

    await user.click(await screen.findByRole('button', { name: 'Regenerate with a passkey' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Regenerate recovery codes with a passkey?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Use my passkey' }));

    expect(await screen.findByText(/Couldn't confirm with your passkey/)).toBeInTheDocument();
    expect(screen.queryByText('Your new recovery codes')).not.toBeInTheDocument();
  });

  it('leaves the codes alone when the dialog is cancelled', async () => {
    const { user } = await renderWith({ count: 1 });

    await user.click(await screen.findByRole('button', { name: 'Regenerate with a passkey' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Regenerate recovery codes with a passkey?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(ceremony.assert).not.toHaveBeenCalled();
  });
});
