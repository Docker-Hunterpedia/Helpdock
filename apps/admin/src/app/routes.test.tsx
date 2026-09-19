import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.tsx';
import { ROUTES } from './route-paths.js';
import { AppRoutes } from './routes.tsx';

/**
 * Which app this build is. The install state arrives as a meta tag in the
 * document the api served, so it is decided before the first route renders: a
 * fresh install has one screen, and a configured one has no wizard.
 */

const setInstallState = (state: string): void => {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'helpdock:install-state');
  meta.setAttribute('content', state);
  document.head.append(meta);
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'ready', checks: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const meta of document.head.querySelectorAll('meta[name="helpdock:install-state"]')) {
    meta.remove();
  }
});

describe('a fresh install', () => {
  it.each([ROUTES.setup, ROUTES.signIn, ROUTES.tickets, '/anything'])(
    'sends %s to the wizard, because there is nobody to sign in as',
    async (path) => {
      setInstallState('fresh');

      renderApp(<AppRoutes />, { initialEntries: [path] });

      expect(
        await screen.findByRole('heading', { name: 'Set up Helpdock', level: 1 }),
      ).toBeInTheDocument();
    },
  );
});

describe('a configured install', () => {
  it('has no wizard to reach', async () => {
    setInstallState('configured');

    renderApp(<AppRoutes />, { initialEntries: [ROUTES.setup] });

    expect(screen.queryByRole('heading', { name: 'Set up Helpdock' })).not.toBeInTheDocument();
    // `/setup` is not a route here, so it falls to the catch-all, which sends
    // an unauthenticated visitor to sign in like every other unknown path.
    expect(await screen.findByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument();
  });

  it('still shows the sign-in screen it always did', () => {
    setInstallState('configured');

    renderApp(<AppRoutes />, { initialEntries: [ROUTES.signIn] });

    expect(screen.getByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument();
  });
});
