import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MockDevelopersApi } from '../../../developers/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * Developers › Webhooks (M8-03) against the fixture: the turned-off Banner,
 * the endpoints, the delivery log and one delivery as it was sent, adding an
 * endpoint (refusals included), the secret shown once with a test ping, and
 * rotating. That the routes behave is `api-v1.integration.test.ts` in the api.
 */

const SLOW = { timeout: 10_000 };
const ACME = 'https://ops.acme-shop.com/hooks/helpdock';
const LEGACY = 'https://hooks.legacy-crm.example/helpdock';

const renderWebhooks = async (developers = new MockDevelopersApi(), ready = 'Endpoints') => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    developersApi: developers,
    initialEntries: ['/admin/developers/webhooks'],
  });
  await screen.findByRole('heading', { name: ready }, SLOW);
  return rendered;
};

const endpoints = () => screen.getByRole('table', { name: 'Webhook endpoints' });

const endpointRow = (url: string): HTMLElement => {
  const row = within(endpoints())
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(url) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${url}`);
  }
  return row;
};

const addEndpoint = async (
  user: Awaited<ReturnType<typeof renderWebhooks>>['user'],
  url: string,
) => {
  await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add endpoint' });
  await user.click(within(dialog).getByLabelText('Endpoint URL · required'));
  await user.paste(url);
  await user.click(within(dialog).getByRole('checkbox', { name: 'ticket.created' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
  return dialog;
};

describe('Developers › Webhooks', () => {
  it('says which endpoint Helpdock turned off and why, and turns it back on', async () => {
    const { user } = await renderWebhooks();

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(`Turned off: ${LEGACY}`);
    expect(banner).toHaveTextContent('10 deliveries in a row used up all their retries');
    expect(banner).toHaveTextContent('the last answer was 503');
    expect(within(endpointRow(LEGACY)).getByText('Turned off')).toBeVisible();

    await user.click(within(banner).getByRole('button', { name: 'Turn back on' }));

    expect(await screen.findByText(`${LEGACY} turned back on`)).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('lists endpoints with their events, success rate and last delivery', async () => {
    await renderWebhooks();

    const acme = endpointRow(ACME);
    expect(within(acme).getByText('ticket.created')).toBeVisible();
    expect(within(acme).getByText('+2')).toBeVisible();
    expect(within(acme).getByText('100%')).toBeVisible();
    expect(within(acme).getByText('3 of 3 · 24 h')).toBeVisible();
    expect(acme).toHaveTextContent('500 · retrying');
    expect(within(acme).getByText(/attempt 3\/8 · /)).toBeVisible();
    expect(
      within(endpointRow('https://hooks.zapier.com/hooks/catch/18392/abx')).getByText(
        'All 7 events',
      ),
    ).toBeVisible();
  });

  it('opens the first endpoint’s log and shows a delivery as it was sent', async () => {
    await renderWebhooks();

    expect(screen.getByRole('heading', { level: 2, name: ACME })).toBeVisible();
    const log = await screen.findByRole('table', { name: `Deliveries to ${ACME}` });
    const first = within(log).getAllByRole('row')[1] as HTMLElement;
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(within(first).getByText('500')).toBeVisible();
    expect(within(first).getByText(/^Next retry /)).toBeVisible();

    const detail = await screen.findByRole('list', { name: 'Attempts' });
    expect(
      within(detail)
        .getAllByRole('listitem')
        .map((chip) => chip.textContent),
    ).toEqual([
      '1 · failed',
      '2 · failed',
      expect.stringMatching(/^3 · \d\d:\d\d · 500$/),
      expect.stringMatching(/^4 · next \d\d:\d\d$/),
    ]);
    expect(screen.getByText('5–8 left')).toBeVisible();
    const signature = screen.getByText(/^X-Helpdock-Signature: t=\d+,v1=/);
    expect(signature.tagName).toBe('MARK');
    expect(screen.getByText(/"upstream timeout"/)).toBeVisible();
  });

  it('opens another delivery from the log, filters it, and replays one', async () => {
    const { user } = await renderWebhooks();
    const log = await screen.findByRole('table', { name: `Deliveries to ${ACME}` });

    await user.click(within(log).getByRole('button', { name: /^Open contact\.created delivery/ }));
    expect(await screen.findByText(/Redirect not followed · retry/)).toBeVisible();
    expect(
      await screen.findByText(/No response: The endpoint answered with a redirect/),
    ).toBeVisible();

    await user.click(screen.getByRole('combobox', { name: 'Filter deliveries' }));
    await user.click(await screen.findByRole('option', { name: 'Delivered' }));
    expect(within(log).queryByText('contact.created')).toBeNull();
    expect(within(log).getAllByText('ticket.created')).toHaveLength(2);

    await user.click(within(log).getByRole('button', { name: /^Open ticket\.closed delivery/ }));
    await user.click(await screen.findByRole('button', { name: 'Replay this delivery' }));
    expect(await screen.findByText('Replay queued')).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Filter deliveries' }));
    await user.click(await screen.findByRole('option', { name: 'All results' }));
    expect(await within(log).findByText(/^replay · /)).toBeVisible();
  });

  it('refuses plain http and a private address under the URL field', async () => {
    const { user } = await renderWebhooks();

    const dialog = await addEndpoint(user, 'http://ops.acme-shop.com/hooks/helpdock');
    expect(
      await within(dialog).findByText('Use https://. Webhooks are never sent over plain HTTP.'),
    ).toBeVisible();

    const field = within(dialog).getByLabelText('Endpoint URL · required');
    await user.clear(field);
    await user.paste('https://billing.internal.acme-shop.com/hooks');
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
    expect(
      await within(dialog).findByText(/Address resolves to a private network \(10\.0\.4\.12\)/),
    ).toBeVisible();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('adds an endpoint, shows its secret once, and sends a test ping', async () => {
    const { user } = await renderWebhooks();

    await addEndpoint(user, 'https://hooks.example.com/helpdock');

    const reveal = await screen.findByRole('dialog', { name: 'Endpoint added' });
    const secret = (within(reveal).getByLabelText('Signing secret') as HTMLInputElement).value;
    expect(secret).toMatch(/^whsec_/);
    await user.click(within(reveal).getByRole('button', { name: 'Send test event' }));
    expect(
      await within(reveal).findByText('ping delivered · 200 in 162 ms', {}, SLOW),
    ).toBeVisible();

    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'https://hooks.example.com/helpdock' }),
    ).toBeVisible();
    expect(screen.queryByDisplayValue(secret)).toBeNull();
  });

  it('rotates the signing secret behind a confirmation and shows the new one once', async () => {
    const { user } = await renderWebhooks();

    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    const confirm = await screen.findByRole('dialog', { name: 'Rotate the signing secret?' });
    await user.click(within(confirm).getByRole('button', { name: 'Rotate' }));

    const reveal = await screen.findByRole('dialog', { name: 'Copy your new signing secret' });
    expect((within(reveal).getByLabelText('Signing secret') as HTMLInputElement).value).toMatch(
      /^whsec_/,
    );
    expect(within(reveal).queryByRole('button', { name: 'Send test event' })).toBeNull();
  });

  it('deletes an endpoint from its row menu', async () => {
    const { user } = await renderWebhooks();

    await user.click(
      within(endpointRow(LEGACY)).getByRole('button', { name: `Actions for ${LEGACY}` }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: `Delete ${LEGACY}?` });
    await user.click(within(confirm).getByRole('button', { name: 'Delete endpoint' }));

    expect(await screen.findByText(`${LEGACY} deleted`)).toBeVisible();
    await waitFor(() => {
      expect(within(endpoints()).queryByText(LEGACY)).toBeNull();
    });
  });

  it('draws the empty state when the brand has no endpoints', async () => {
    const developers = new MockDevelopersApi();
    developers.webhooks = async () => ({ webhooks: [] });

    await renderWebhooks(developers, 'No endpoints yet');

    expect(screen.getAllByRole('button', { name: 'Add endpoint' })).toHaveLength(2);
  });
});
