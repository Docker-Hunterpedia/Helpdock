import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK_BRANDS, MockAuthApi } from '../auth/mock-api.js';
import { renderApp } from '../test/render.tsx';
import { SignIn } from './sign-in.tsx';
import { SsoEmailForm } from './sso-sign-in.tsx';

const connections = [
  { id: MOCK_BRANDS[0]?.id ?? '', name: 'Work OIDC', emailDomains: ['example.com'] },
  { id: MOCK_BRANDS[1]?.id ?? '', name: 'Work SAML', emailDomains: ['example.com'] },
];

describe('SSO sign-in', () => {
  it('shows enabled providers alongside local sign-in when enforcement is off', async () => {
    const auth = new MockAuthApi();
    auth.ssoConnections = connections;
    renderApp(<SignIn />, { authApi: auth });
    expect(await screen.findByRole('link', { name: 'Continue with Work OIDC' })).toHaveAttribute(
      'href',
      expect.stringContaining('code=mock-sso'),
    );
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('uses email discovery when enforced and offers the emergency password form explicitly', async () => {
    const auth = new MockAuthApi();
    auth.ssoConnections = connections;
    auth.ssoEnforced = true;
    const { user } = renderApp(<SignIn />, { authApi: auth });
    expect(await screen.findByLabelText('Work email')).toHaveAttribute('dir', 'ltr');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Break-glass sign-in for admins' }));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Email me a sign-in link' }),
    ).not.toBeInTheDocument();
  });

  it('offers each matching provider and refuses an unmatched domain without an account lookup', async () => {
    const auth = new MockAuthApi();
    auth.ssoConnections = connections;
    const { user } = renderApp(<SsoEmailForm returnTo="/tickets" />, { authApi: auth });
    await user.type(screen.getByLabelText('Work email'), 'unknown@example.com');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByRole('link', { name: 'Continue with Work SAML' }),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Work email'));
    await user.type(screen.getByLabelText('Work email'), 'unknown@elsewhere.example');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText(
        'No enabled sign-in connection matches this email domain. Ask an administrator for access.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Continue with Work SAML' })).not.toBeInTheDocument();
  });
});
