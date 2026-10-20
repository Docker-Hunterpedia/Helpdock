import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_AUTHENTICATION_SETTINGS, MockSettingsApi } from '../../../settings/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { SettingsPage } from './settings-page.tsx';

describe('SettingsPage', () => {
  it('shows persisted values, environment locks and real callback URLs without a secret', async () => {
    renderApp(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Sign-in methods' })).toBeVisible();
    expect(
      screen.getByRole('checkbox', {
        name: /Require two-factor authentication for all staff/,
      }),
    ).toBeChecked();
    expect(screen.getByLabelText('Magic link validity (minutes)')).toHaveValue(10);
    expect(screen.getByDisplayValue('8123.apps.googleusercontent.com')).toHaveAttribute('readonly');
    expect(screen.getByText(/HD_OAUTH_GOOGLE_CLIENT_ID/)).toBeVisible();
    expect(screen.getByText('http://localhost:5273/api/auth/oauth/google/callback')).toBeVisible();
    expect(screen.queryByDisplayValue('must-not-leak')).not.toBeInTheDocument();
  });

  it('copies each redirect URL from a button named after it', async () => {
    const { user } = renderApp(<SettingsPage />);

    await user.click(
      await screen.findByRole('button', { name: 'Copy the GitHub OAuth redirect URL' }),
    );

    // user-event installs its own clipboard, so what was copied can be read back.
    expect(await navigator.clipboard.readText()).toMatch(/\/oauth\/github\/callback$/);
    expect(await screen.findByText('Redirect URL copied.')).toBeVisible();
  });

  it('saves a new provider secret once and never puts it back in the form', async () => {
    const api = new MockSettingsApi();
    const save = vi.spyOn(api, 'saveAuthentication');
    const { user } = renderApp(<SettingsPage />, { settingsApi: api });
    await screen.findByRole('heading', { name: 'Sign-in methods' });

    const github = screen.getByText('GitHub OAuth').closest('div')?.parentElement;
    expect(github).not.toBeNull();
    const fields = within(github as HTMLElement);
    await user.type(fields.getByLabelText('Client ID'), 'github-id');
    await user.type(fields.getByLabelText('Client secret'), 'github-secret');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          github: { clientId: 'github-id', clientSecret: 'github-secret' },
        }),
      );
    });
    expect(await screen.findByText('Authentication settings saved')).toBeVisible();
    expect(screen.queryByDisplayValue('github-secret')).not.toBeInTheDocument();
  });

  it('keeps an invalid magic-link lifetime in the browser', async () => {
    const api = new MockSettingsApi();
    const save = vi.spyOn(api, 'saveAuthentication');
    const { user } = renderApp(<SettingsPage />, { settingsApi: api });
    const validity = await screen.findByLabelText('Magic link validity (minutes)');

    await user.clear(validity);
    await user.type(validity, '61');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Enter a whole number from 1 to 60.')).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });

  it('adds allowed Workspace domains as chips, refuses an address, and saves the list', async () => {
    const api = new MockSettingsApi();
    const save = vi.spyOn(api, 'saveAuthentication');
    const { user } = renderApp(<SettingsPage />, { settingsApi: api });
    const domains = await screen.findByLabelText('Allowed Workspace domains');

    await user.type(domains, 'lina@gmail.com{Enter}');
    expect(screen.getByText('Enter a domain like example.com, without @.')).toBeVisible();
    expect(domains).toHaveAccessibleDescription('Enter a domain like example.com, without @.');

    await user.clear(domains);
    await user.type(domains, ' Helpdock.COM{Enter}@helpdock.sa{Enter}');
    expect(screen.getByText('helpdock.com')).toBeVisible();
    expect(screen.getByText('helpdock.sa')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          google: expect.objectContaining({ allowedDomains: ['helpdock.com', 'helpdock.sa'] }),
        }),
      );
    });
  });

  it('shows domains pinned by the environment as read-only', async () => {
    const api = new MockSettingsApi();
    vi.spyOn(api, 'authentication').mockResolvedValue({
      ...MOCK_AUTHENTICATION_SETTINGS,
      google: {
        ...MOCK_AUTHENTICATION_SETTINGS.google,
        allowedDomains: ['helpdock.com'],
        allowedDomainsLocked: true,
      },
    });
    renderApp(<SettingsPage />, { settingsApi: api });

    const domains = await screen.findByLabelText('Allowed Workspace domains');
    expect(domains).toHaveAttribute('readonly');
    expect(domains).toHaveAccessibleDescription(/HD_OAUTH_GOOGLE_ALLOWED_DOMAINS/);
    expect(screen.getByText('helpdock.com')).toBeVisible();
  });
});
