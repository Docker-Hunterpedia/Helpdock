import type { InstallPasskeys } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_INSTALL_PASSKEYS, MockSettingsApi } from '../../../settings/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { SettingsPage } from './settings-page.tsx';

/**
 * The Passkeys section of Settings › Authentication (M18-06,
 * `Admin/Settings-Authentication`): the three states of the status badge, the
 * drift warning with its move, and what a refused or failed move leaves.
 */

const apiWith = (overrides: Partial<InstallPasskeys>): MockSettingsApi => {
  const api = new MockSettingsApi();
  vi.spyOn(api, 'passkeys').mockResolvedValue({ ...MOCK_INSTALL_PASSKEYS, ...overrides });
  return api;
};

const section = async () => screen.findByRole('region', { name: 'Passkeys' });

const paused: Partial<InstallPasskeys> = {
  state: 'paused',
  rpId: 'desk.helpdock.com',
  pinnedRpId: 'admin.helpdock.com',
};

describe('PasskeysSection', () => {
  it('shows an available install: the pinned RP ID read-only, its date and the usage', async () => {
    renderApp(<SettingsPage />);
    const region = await section();

    expect(within(region).getByText('Available')).toBeVisible();
    expect(within(region).getByLabelText('Relying party ID')).toHaveValue('localhost');
    expect(within(region).getByLabelText('Relying party ID')).toHaveAttribute('readonly');
    expect(within(region).getByText(/Pinned at first use on .*2026/)).toBeVisible();
    expect(within(region).getByText('12 passkeys across 7 staff')).toBeVisible();
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says so, with no count, before any passkey exists', async () => {
    renderApp(<SettingsPage />, {
      settingsApi: apiWith({ pinnedRpId: null, pinnedAt: null, passkeyCount: 0, holderCount: 0 }),
    });
    const region = await section();

    expect(within(region).getByText('No passkeys yet')).toBeVisible();
    expect(within(region).getByText(/Not pinned yet/)).toBeVisible();
    expect(within(region).getByLabelText('Relying party ID')).toHaveValue('localhost');
  });

  it('marks an RP ID the environment pins', async () => {
    renderApp(<SettingsPage />, { settingsApi: apiWith({ pinLocked: true, pinnedAt: null }) });
    const region = await section();

    expect(within(region).getByText('Set by environment')).toBeVisible();
    expect(within(region).getByText(/Pinned by the environment/)).toBeVisible();
  });

  it('explains an install without HTTPS and offers nothing', async () => {
    renderApp(<SettingsPage />, {
      settingsApi: apiWith({ state: 'unavailable', rpId: null, pinnedRpId: null }),
    });
    const region = await section();

    expect(within(region).getByText('Unavailable')).toBeVisible();
    expect(within(region).getByText(/Passkeys need HTTPS/)).toBeVisible();
    expect(within(region).queryByLabelText('Relying party ID')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
  });

  it('names both hosts when the address moved and offers to move the passkeys', async () => {
    renderApp(<SettingsPage />, { settingsApi: apiWith(paused) });
    const region = await section();

    expect(within(region).getByText('Paused')).toBeVisible();
    expect(within(region).getByText("This install's address changed")).toBeVisible();
    expect(within(region).getByText('admin.helpdock.com').closest('bdi')).toHaveAttribute(
      'dir',
      'ltr',
    );
    expect(within(region).getByText('desk.helpdock.com').closest('bdi')).toHaveAttribute(
      'dir',
      'ltr',
    );
    expect(
      within(region).getByRole('button', { name: 'Move passkeys to desk.helpdock.com' }),
    ).toBeVisible();
  });

  it('moves only after the confirmation says every passkey stops working', async () => {
    const api = apiWith(paused);
    const move = vi.spyOn(api, 'movePasskeys').mockResolvedValue({
      rpId: 'desk.helpdock.com',
      passkeysRemoved: 12,
      holdersNotified: 7,
    });
    const { user } = renderApp(<SettingsPage />, { settingsApi: api });
    const region = await section();

    await user.click(
      within(region).getByRole('button', { name: 'Move passkeys to desk.helpdock.com' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Move passkeys to desk.helpdock.com?',
    });
    expect(within(dialog).getByText(/Every existing passkey stops working/)).toBeVisible();
    expect(move).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Move passkeys' }));

    expect(await screen.findByText('Passkeys moved. 12 removed.')).toBeVisible();
    expect(move).toHaveBeenCalledOnce();
  });

  it('says what the move would break, and will not confirm, while accounts would be locked out', async () => {
    const api = apiWith({
      ...paused,
      blockers: { breakGlassAccounts: 1, secondFactorAccounts: 3 },
    });
    const move = vi.spyOn(api, 'movePasskeys');
    const { user } = renderApp(<SettingsPage />, { settingsApi: api });
    const region = await section();

    await user.click(
      within(region).getByRole('button', { name: 'Move passkeys to desk.helpdock.com' }),
    );
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Add an authenticator app first')).toBeVisible();
    expect(within(dialog).getByText(/1 emergency sign-in account/)).toBeVisible();
    expect(within(dialog).getByText(/3 accounts must have a second factor/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Move passkeys' })).toBeDisabled();
    expect(move).not.toHaveBeenCalled();
  });

  it('tells people without an authenticator app they lose their recovery codes', async () => {
    const { user } = renderApp(<SettingsPage />, { settingsApi: apiWith(paused) });
    const region = await section();

    await user.click(
      within(region).getByRole('button', { name: 'Move passkeys to desk.helpdock.com' }),
    );
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/lose their recovery codes/)).toBeVisible();
    expect(within(dialog).getByText(/set up a second factor again/)).toBeVisible();
  });

  it('does not move when the confirmation is cancelled', async () => {
    const api = apiWith(paused);
    const move = vi.spyOn(api, 'movePasskeys');
    const { user } = renderApp(<SettingsPage />, { settingsApi: api });
    const region = await section();

    await user.click(
      within(region).getByRole('button', { name: 'Move passkeys to desk.helpdock.com' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(move).not.toHaveBeenCalled();
  });

  it('says so, and keeps the warning, when the move fails', async () => {
    const api = apiWith(paused);
    vi.spyOn(api, 'movePasskeys').mockRejectedValue(new Error('conflict'));
    const { user } = renderApp(<SettingsPage />, { settingsApi: api });
    const region = await section();

    await user.click(
      within(region).getByRole('button', { name: 'Move passkeys to desk.helpdock.com' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Move passkeys' }));

    expect(await screen.findByText("Couldn't move the passkeys. Try again.")).toBeVisible();
    expect(within(region).getByText("This install's address changed")).toBeVisible();
  });

  it('offers no move when the environment pins the RP ID', async () => {
    renderApp(<SettingsPage />, { settingsApi: apiWith({ ...paused, pinLocked: true }) });
    const region = await section();

    expect(within(region).getByText(/HD_AUTH_WEBAUTHN_RP_ID/)).toBeVisible();
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reports a status that cannot be read without hiding the rest of the form', async () => {
    const api = new MockSettingsApi();
    vi.spyOn(api, 'passkeys').mockRejectedValue(new Error('down'));
    renderApp(<SettingsPage />, { settingsApi: api });

    expect(await screen.findByText("Couldn't read the passkey status.")).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Sign-in methods' })).toBeVisible();
  });
});
