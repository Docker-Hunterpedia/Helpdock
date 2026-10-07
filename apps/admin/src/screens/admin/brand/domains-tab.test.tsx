import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * Brand › Domains (M5-07) against the fixture: the three states the artboard
 * draws, the records with their copy buttons, and every action the tab has.
 * That the routes behave is `domains.integration.test.ts` in the api.
 */

const renderDomains = async () => {
  const { auth, staff, ticketing, domains } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    domainsApi: domains,
    initialEntries: ['/admin/brand/domains'],
  });
  await screen.findByRole('heading', { name: 'Help center domains' });
  await screen.findByText('help.helpdock.com');
  return rendered;
};

const itemFor = (domain: string): HTMLElement => {
  const item = within(screen.getByRole('list', { name: 'Domains' }))
    .getAllByRole('listitem')
    .find((candidate) => within(candidate).queryAllByText(domain).length > 0);
  if (item === undefined) {
    throw new Error(`no row for ${domain}`);
  }
  return item;
};

describe('Brand › Domains', () => {
  it('sits between General and Danger zone, and is selected', async () => {
    await renderDomains();

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['General', 'Domains', 'Danger zone']);
    expect(screen.getByRole('tab', { name: 'Domains' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a verified primary domain, a pending one and a failed one, each in words', async () => {
    await renderDomains();

    const verified = itemFor('help.helpdock.com');
    expect(within(verified).getByText('Primary')).toBeVisible();
    expect(within(verified).getByText(/Verified · certificate issued/)).toBeVisible();
    expect(within(verified).queryByRole('table')).toBeNull();

    const pending = itemFor('support.helpdock.com');
    expect(within(pending).getByText(/Waiting for DNS · checked/)).toBeVisible();
    const records = within(pending).getByRole('table', {
      name: 'DNS records for support.helpdock.com',
    });
    expect(within(records).getByText('_helpdock.support.helpdock.com')).toBeVisible();
    expect(within(records).getByText('Found')).toBeVisible();
    expect(within(records).getByText('Not yet')).toBeVisible();

    const failed = itemFor('help.helpdock.sa');
    expect(within(failed).getByText('Certificate failed')).toBeVisible();
    expect(within(failed).getByRole('alert')).toHaveTextContent(
      /resolves to Cloudflare \(104\.21\.48\.12\)/,
    );
  });

  it('copies a record value', async () => {
    const { user } = await renderDomains();

    await user.click(
      within(itemFor('support.helpdock.com')).getByRole('button', { name: 'Copy the TXT value' }),
    );

    expect(await navigator.clipboard.readText()).toBe(
      'helpdock-verify=7f3a9c2e41b8d05f6a1e0c9d8b7a6f5e',
    );
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
  });

  it('adds a domain and shows the records to create for it', async () => {
    const { user, domainsApi } = await renderDomains();
    const add = vi.spyOn(domainsApi, 'addDomain');

    await user.type(screen.getByLabelText('Add a domain'), 'docs.acme.com');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));

    expect(add).toHaveBeenCalledWith(expect.any(String), 'docs.acme.com');
    expect(
      await screen.findByRole('table', { name: 'DNS records for docs.acme.com' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Add a domain')).toHaveValue('');
  });

  it('says why a domain was refused, under the field', async () => {
    const { user } = await renderDomains();
    const field = screen.getByLabelText('Add a domain');

    await user.type(field, 'printer.local');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));

    expect(await screen.findByText(/can never be reached from the internet/)).toBeVisible();
    expect(field).toHaveAttribute('aria-invalid', 'true');

    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(await screen.findByText(/Enter a host name such as/)).toBeVisible();
  });

  it('asks for a check, and for a new try on a failed domain', async () => {
    const { user, domainsApi } = await renderDomains();
    const check = vi.spyOn(domainsApi, 'checkDomain');

    await user.click(
      within(itemFor('support.helpdock.com')).getByRole('button', { name: /Check now/ }),
    );
    expect(await screen.findByText(/Checking support.helpdock.com/)).toBeInTheDocument();

    await user.click(
      within(itemFor('help.helpdock.sa')).getByRole('button', { name: /Try again/ }),
    );
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('flags a domain as proxied by Cloudflare', async () => {
    const { user, domainsApi } = await renderDomains();
    const update = vi.spyOn(domainsApi, 'updateDomain');

    await user.click(
      within(itemFor('help.helpdock.sa')).getByRole('checkbox', { name: 'Proxied by Cloudflare' }),
    );

    expect(update).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      cloudflareProxied: true,
    });
    expect(
      await within(itemFor('help.helpdock.sa')).findByText('Verified · Cloudflare serves HTTPS'),
    ).toBeVisible();
  });

  it('moves primary through the row menu', async () => {
    const { user } = await renderDomains();

    await user.click(
      within(itemFor('help.helpdock.sa')).getByRole('checkbox', { name: 'Proxied by Cloudflare' }),
    );
    await within(itemFor('help.helpdock.sa')).findByText('Verified · Cloudflare serves HTTPS');
    await user.click(screen.getByRole('button', { name: 'Actions for help.helpdock.sa' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Make primary' }));

    expect(await screen.findByText('help.helpdock.sa is now the primary domain.')).toBeVisible();
    expect(within(itemFor('help.helpdock.sa')).getByText('Primary')).toBeVisible();
    expect(within(itemFor('help.helpdock.com')).queryByText('Primary')).toBeNull();
  });

  it('removes a domain after asking', async () => {
    const { user } = await renderDomains();

    await user.click(screen.getByRole('button', { name: 'Actions for support.helpdock.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove domain' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove support.helpdock.com?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove domain' }));

    expect(await screen.findByText('support.helpdock.com removed.')).toBeInTheDocument();
    expect(screen.queryByText('support.helpdock.com')).toBeNull();
  });

  it('points widget sites at Channels › Widget', async () => {
    await renderDomains();

    expect(screen.getByRole('link', { name: 'Channels › Widget' })).toHaveAttribute(
      'href',
      '/admin/channels/widget',
    );
  });

  it('says so when the list cannot be loaded', async () => {
    const { auth, staff, ticketing, domains } = await signedInMockApis();
    vi.spyOn(domains, 'domains').mockRejectedValue(new Error('down'));
    renderApp(<AppRoutes />, {
      authApi: auth,
      staffApi: staff,
      ticketingApi: ticketing,
      domainsApi: domains,
      initialEntries: ['/admin/brand/domains'],
    });

    expect(await screen.findByText('The domains could not be loaded.')).toBeVisible();
  });
});
