import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MockSettingsApi } from '../../../settings/mock-api.js';
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
});
