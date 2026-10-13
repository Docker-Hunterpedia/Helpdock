import type { SsoConnectionInput } from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MockAuthApi } from '../../../auth/mock-api.js';
import { MockSsoApi } from '../../../sso/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { SsoConnectionPage } from './sso-connection-page.tsx';
import { SsoTab } from './sso-tab.tsx';

const input: SsoConnectionInput = {
  name: 'Work',
  enabled: true,
  emailDomains: ['example.com'],
  jitEnabled: true,
  idpEnforcesMfa: false,
  groupAttribute: 'groups',
  defaultAccess: null,
  clientSecret: 'never-return-this',
  config: {
    protocol: 'oidc',
    issuer: 'https://idp.example.com',
    clientId: 'helpdock',
    scopes: ['openid', 'email', 'profile'],
    emailClaim: 'email',
    nameClaim: 'name',
    requireEmailVerified: true,
  },
};

describe('SSO administration', () => {
  it('shows connections and refuses enforcement without an enabled provider', async () => {
    const auth = new MockAuthApi();
    const sso = new MockSsoApi(auth);
    const { user } = renderApp(<SsoTab />, { authApi: auth, ssoApi: sso });
    expect(await screen.findByText('No identity provider yet')).toBeVisible();
    await user.click(
      screen.getByRole('checkbox', { name: 'Require single sign-on for all staff' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(
        'Could not save. Check the fields, permissions and emergency admin requirements.',
      ),
    ).toBeVisible();
    expect((await sso.settings()).enforced).toBe(false);
  });

  it('saves a connection and mappings together and clears the submitted secret', async () => {
    const sso = new MockSsoApi();
    const { user } = renderApp(<SsoConnectionPage />, { ssoApi: sso });
    await user.type(await screen.findByLabelText('Button label'), 'Work');
    await user.type(
      screen.getByLabelText('Issuer URL'),
      input.config.protocol === 'oidc' ? input.config.issuer : '',
    );
    await user.type(screen.getByLabelText('Client ID'), 'helpdock');
    await user.type(screen.getByLabelText('Client secret'), 'never-return-this');
    await user.type(screen.getByLabelText('Email domains'), 'example.com');
    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    await user.type(screen.getByLabelText('Group from the provider'), 'Support');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(async () => expect((await sso.connections()).connections).toHaveLength(1));
    const connection = (await sso.connections()).connections[0];
    if (!connection) throw new Error('Missing saved connection');
    expect(await sso.mappings(connection.id)).toMatchObject({
      mappings: [{ idpGroup: 'Support', role: 'viewer' }],
    });
    expect(connection.secretConfigured).toBe(true);
    expect(JSON.stringify(connection)).not.toContain('never-return-this');
    await waitFor(() =>
      expect(screen.queryByDisplayValue('never-return-this')).not.toBeInTheDocument(),
    );
  });

  it('keeps invalid connection values in the form without creating a provider', async () => {
    const sso = new MockSsoApi();
    const { user } = renderApp(<SsoConnectionPage />, { ssoApi: sso });
    await screen.findByLabelText('Button label');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));
    expect(await screen.findByText('Check the connection fields and mappings.')).toBeVisible();
    expect((await sso.connections()).connections).toEqual([]);
  });
});
