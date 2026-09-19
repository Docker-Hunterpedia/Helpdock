import type { Session } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import type { MockAuthApi } from '../auth/mock-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApi } from '../test/signed-in.js';

/**
 * The System page is install-wide — the schema, the queues, the database role —
 * so the nav offers it only to an install admin. The route itself is not
 * hidden: the api refuses a brand admin and the page draws that refusal, so
 * there is one answer rather than two that could disagree.
 */

/** The fixture's session with `installAdmin` turned off, which it cannot do itself. */
const brandAdminApi = async (): Promise<MockAuthApi> => {
  const api = await signedInMockApi();
  const session = await api.me();
  if (session === null) {
    throw new Error('expected a session');
  }

  const downgraded: Session = { ...session, user: { ...session.user, installAdmin: false } };
  api.me = async () => downgraded;

  return api;
};

const navLinks = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');

describe('the admin nav', () => {
  it('offers System to an install admin', async () => {
    renderApp(<AppRoutes />, { authApi: await signedInMockApi(), initialEntries: ['/tickets'] });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).toContain('System');
  });

  it('does not offer System to a brand admin', async () => {
    renderApp(<AppRoutes />, { authApi: await brandAdminApi(), initialEntries: ['/tickets'] });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).not.toContain('System');
    // The other admin destinations are still there, so this is one item hidden
    // rather than a group that disappeared.
    expect(navLinks()).toContain('Settings');
    expect(navLinks()).toContain('Staff and roles');
  });
});
