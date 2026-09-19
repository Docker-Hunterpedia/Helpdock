import type { Session } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import type { MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';

/**
 * The System page is install-wide — the schema, the queues, the database role —
 * so the nav offers it only to an install admin. "Staff and roles" is offered
 * to the two roles that hold `staff:manage`. Neither is a permission: the route
 * is not hidden, the api refuses the request, and the page draws that refusal,
 * so there is one answer rather than two that could disagree.
 */

/** `renderApp` names the pair as props; `signedInMockApis` names them as the app does. */
const asProps = ({ auth, staff }: AdminApis) => ({ authApi: auth, staffApi: staff });

/** The fixture's session with a field changed, which it cannot change itself. */
const withUser = async (changes: Partial<Session['user']>): Promise<AdminApis> => {
  const apis = await signedInMockApis();
  const session = await apis.auth.me();
  if (session === null) {
    throw new Error('expected a session');
  }

  const changed: Session = { ...session, user: { ...session.user, ...changes } };
  (apis.auth as MockAuthApi).me = async () => changed;

  return apis;
};

const navLinks = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');

describe('the admin nav', () => {
  it('offers System to an install admin', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await signedInMockApis()),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).toContain('System');
  });

  it('does not offer System to a brand admin', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser({ installAdmin: false })),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).not.toContain('System');
    // The other admin destinations are still there, so this is one item hidden
    // rather than a group that disappeared.
    expect(navLinks()).toContain('Settings');
    expect(navLinks()).toContain('Staff and roles');
  });

  /** DOMAIN-RULES §1.2: only an Admin and a Team Leader hold `staff:manage`. */
  it.each(['agent', 'viewer'] as const)('does not offer Staff and roles to %s', async (role) => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser({ role, installAdmin: false })),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).not.toContain('Staff and roles');
    expect(navLinks()).toContain('Settings');
  });

  it('offers Staff and roles to a Team Leader', async () => {
    renderApp(<AppRoutes />, {
      ...asProps(await withUser({ role: 'teamLeader', installAdmin: false })),
      initialEntries: ['/tickets'],
    });
    await screen.findByRole('navigation', { name: 'Main' });

    expect(navLinks()).toContain('Staff and roles');
  });
});
