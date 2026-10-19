import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { AuthError } from '../auth/api.js';
import { MOCK_EMAIL, MOCK_MAGIC_LINK_TOKEN, MockAuthApi } from '../auth/mock-api.js';
import { renderApp } from '../test/render.tsx';

/**
 * `Admin/SignIn-MagicLink`: where a sign-in link opens (M9-01 F6). Opening it
 * must spend nothing; only the click does.
 */

const INVALID = 'This sign-in link has expired or was already used. Ask for a new one.';

const renderLink = (hash: string, authApi = new MockAuthApi()) =>
  renderApp(<AppRoutes />, { authApi, initialEntries: [`/sign-in/magic${hash}`] });

describe('a live sign-in link', () => {
  it('says whose account it opens and how long such a link lasts, and spends nothing', async () => {
    const authApi = new MockAuthApi();
    const consume = vi.spyOn(authApi, 'consumeMagicLink');
    renderLink(`#token=${MOCK_MAGIC_LINK_TOKEN}`, authApi);

    expect(await screen.findByText(MOCK_EMAIL)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finish signing in', level: 1 })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Continue to Helpdock' }),
    ).toHaveAccessibleDescription(
      'The link works once and expires 10 minutes after it was sent. Two-factor follows if your account uses it.',
    );
    expect(screen.getByRole('link', { name: 'Not you? Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it('spends the link on Continue and asks for the second factor, as a password would', async () => {
    const authApi = new MockAuthApi();
    const consume = vi.spyOn(authApi, 'consumeMagicLink');
    const { user } = renderLink(`#token=${MOCK_MAGIC_LINK_TOKEN}`, authApi);

    await user.click(await screen.findByRole('button', { name: 'Continue to Helpdock' }));

    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeVisible();
    expect(consume).toHaveBeenCalledExactlyOnceWith(MOCK_MAGIC_LINK_TOKEN);
  });

  it('keeps the button when a click fails for a reason another click may not', async () => {
    const authApi = new MockAuthApi();
    vi.spyOn(authApi, 'consumeMagicLink').mockRejectedValueOnce(new AuthError('unavailable'));
    const { user } = renderLink(`#token=${MOCK_MAGIC_LINK_TOKEN}`, authApi);

    await user.click(await screen.findByRole('button', { name: 'Continue to Helpdock' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in is unavailable right now. Try again in a moment.',
    );
    expect(screen.getByRole('button', { name: 'Continue to Helpdock' })).toBeEnabled();
  });

  it('turns into the expired state when the link was spent elsewhere before the click', async () => {
    const authApi = new MockAuthApi();
    const { user } = renderLink(`#token=${MOCK_MAGIC_LINK_TOKEN}`, authApi);
    await screen.findByText(MOCK_EMAIL);
    await authApi.consumeMagicLink(MOCK_MAGIC_LINK_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Continue to Helpdock' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID);
    expect(screen.queryByRole('button', { name: 'Continue to Helpdock' })).not.toBeInTheDocument();
  });
});

describe('a link that cannot sign anybody in', () => {
  it.each([
    ['an expired or used token', '#token=used-already'],
    ['no token at all', ''],
  ])('says so for %s and offers the way back', async (_case, hash) => {
    renderLink(hash);

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID);
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.queryByRole('button', { name: 'Continue to Helpdock' })).not.toBeInTheDocument();
  });

  it('names single sign-on when the install enforces it', async () => {
    const authApi = new MockAuthApi();
    authApi.ssoEnforced = true;
    renderLink(`#token=${MOCK_MAGIC_LINK_TOKEN}`, authApi);

    expect(await screen.findByRole('alert')).toHaveTextContent('Use single sign-on to continue.');
  });
});
