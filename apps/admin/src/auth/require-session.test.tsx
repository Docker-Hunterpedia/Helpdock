import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';

/** `signedInMockApis` names the pair the way the app does; `renderApp` names them as props. */
const signedIn = ({ auth, staff }: Awaited<ReturnType<typeof signedInMockApis>>) => ({
  authApi: auth,
  staffApi: staff,
});

import { MockAuthApi } from './mock-api.js';

describe('RequireSession', () => {
  it('sends an anonymous visitor to sign-in', async () => {
    renderApp(<AppRoutes />, {
      authApi: new MockAuthApi(),
      initialEntries: ['/admin/settings'],
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('comes back to the screen that was asked for after signing in', async () => {
    const { user } = renderApp(<AppRoutes />, {
      authApi: new MockAuthApi(),
      initialEntries: ['/admin/settings?tab=email'],
    });

    await user.type(await screen.findByLabelText('Email'), 'lina@helpdock.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.type(await screen.findByLabelText('Authentication code'), '482913');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('lets a signed-in session straight through', async () => {
    renderApp(<AppRoutes />, {
      ...signedIn(await signedInMockApis()),
      initialEntries: ['/reports'],
    });

    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
  });

  it('shows a busy state instead of bouncing while the session is being read', async () => {
    renderApp(<AppRoutes />, {
      ...signedIn(await signedInMockApis()),
      initialEntries: ['/tickets'],
    });

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Tickets' })).toBeInTheDocument();
  });

  it('sends an unknown path to the default screen', async () => {
    renderApp(<AppRoutes />, {
      ...signedIn(await signedInMockApis()),
      initialEntries: ['/nowhere'],
    });

    expect(await screen.findByRole('heading', { name: 'Tickets' })).toBeInTheDocument();
  });
});
