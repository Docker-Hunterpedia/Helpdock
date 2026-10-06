import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MockDevelopersApi } from '../../../developers/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * Developers › API keys (M8-01) against the fixture: the table the artboard
 * draws, creating a key and seeing it once, revoking one behind its
 * confirmation, and the empty state. That the routes behave is
 * `api-v1.integration.test.ts` in the api.
 */

const renderKeys = async (developers = new MockDevelopersApi(), ready = 'API keys') => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    developersApi: developers,
    initialEntries: ['/admin/developers'],
  });
  await screen.findByRole('heading', { name: ready });
  return rendered;
};

const table = () => screen.getByRole('table', { name: 'API keys' });

const rowFor = (name: string): HTMLElement => {
  const row = within(table())
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${name}`);
  }
  return row;
};

describe('Developers › API keys', () => {
  it('opens on API keys, beside Webhooks, from the Developers nav item', async () => {
    await renderKeys();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'API keys',
      'Webhooks',
    ]);
    expect(screen.getByRole('tab', { name: 'API keys' })).toHaveAttribute('aria-selected', 'true');
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Developers',
      }),
    ).toHaveAttribute('href', '/admin/developers');
    expect(screen.getByRole('link', { name: 'API docs (opens /api/docs)' })).toHaveAttribute(
      'href',
      '/api/docs',
    );
  });

  it('lists each key by prefix with its scopes, limit, author and last use', async () => {
    await renderKeys();

    const zapier = rowFor('Zapier sync');
    expect(within(zapier).getByText('hd_live_ab12…')).toBeVisible();
    expect(within(zapier).getByRole('list', { name: 'Scopes' })).toHaveTextContent(
      'tickets:readtickets:writecontacts:write',
    );
    expect(within(zapier).getByText('600/min')).toBeVisible();
    expect(within(zapier).getByText('Lina Haddad')).toBeVisible();
    expect(within(rowFor('Data warehouse')).getByText('Never used')).toBeVisible();
    expect(screen.getByText(/5 active · 1 revoked · bound to the/)).toBeVisible();
  });

  it('strikes a revoked key through, offers it no Revoke, and hides it on request', async () => {
    const { user } = await renderKeys();

    const old = rowFor('Old CRM import');
    expect(within(old).getByText('Old CRM import')).toHaveStyle({ textDecoration: 'line-through' });
    expect(within(old).getByText(/Revoked .* by Lina Haddad/)).toBeVisible();
    expect(within(old).queryByRole('button', { name: /Revoke/ })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Show revoked' }));
    expect(within(table()).queryByText('Old CRM import')).toBeNull();
  });

  it('creates a key, shows it once, and lists only its prefix afterwards', async () => {
    const { user } = await renderKeys();

    await user.click(screen.getByRole('button', { name: 'Create API key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create API key' });
    await user.type(within(dialog).getByLabelText('Name · required'), 'Shop checkout');
    await user.click(within(dialog).getByRole('checkbox', { name: 'contacts:write' }));
    await user.clear(within(dialog).getByLabelText('Rate limit'));
    await user.type(within(dialog).getByLabelText('Rate limit'), '1200');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    const reveal = await screen.findByRole('dialog', { name: 'Copy your new key' });
    const secret = (within(reveal).getByLabelText('Shop checkout') as HTMLInputElement).value;
    expect(secret).toMatch(/^hd_live_[0-9a-f]{43}$/);
    expect(within(reveal).getByText('1200/min')).toBeVisible();
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(secret);
    expect(within(reveal).getByRole('status')).toHaveTextContent('Copied to the clipboard');

    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(within(rowFor('Shop checkout')).getByText(`${secret.slice(0, 12)}…`)).toBeVisible();
    expect(screen.queryByDisplayValue(secret)).toBeNull();
  });

  it('says what is missing instead of sending an incomplete key', async () => {
    const { user } = await renderKeys();

    await user.click(screen.getByRole('button', { name: 'Create API key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create API key' });
    await user.clear(within(dialog).getByLabelText('Rate limit'));
    await user.type(within(dialog).getByLabelText('Rate limit'), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    expect(within(dialog).getByText('Give the key a name.')).toBeVisible();
    expect(within(dialog).getByText('Choose at least one scope.')).toBeVisible();
    expect(within(dialog).getByText('Enter a whole number from 1 to 10000.')).toBeVisible();
    expect(within(dialog).getByLabelText('Name · required')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('revokes a key behind a confirmation that says what stops working', async () => {
    const { user } = await renderKeys();

    await user.click(
      within(rowFor('Zapier sync')).getByRole('button', { name: 'Revoke Zapier sync' }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Revoke “Zapier sync”?' });
    expect(confirm).toHaveTextContent('hd_live_ab12… stop working at once and get 401');
    await user.click(within(confirm).getByRole('button', { name: 'Revoke key' }));

    expect(await screen.findByText('Zapier sync revoked')).toBeVisible();
    await waitFor(() => {
      expect(within(rowFor('Zapier sync')).queryByRole('button', { name: /Revoke/ })).toBeNull();
    });
  });

  it('draws the empty state when the brand has no keys, and opens Create from it', async () => {
    const developers = new MockDevelopersApi();
    developers.apiKeys = async () => ({ keys: [] });
    const { user } = await renderKeys(developers, 'No API keys yet');

    const buttons = screen.getAllByRole('button', { name: 'Create API key' });
    await user.click(buttons.at(-1) as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'Create API key' })).toBeVisible();
  });
});
