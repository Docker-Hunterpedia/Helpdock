import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MockChannelsApi } from '../../../channels/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/** The first render builds the shell, the brand and three queries; a busy machine needs longer than 1 s. */
const SLOW = { timeout: 10_000 };

/**
 * Channels › Mailboxes and the mailbox form against the fixture: what the
 * screens decide — which health a row shows, what Test IMAP says, which
 * refusal stays on the form, when the secret is shown — rather than markup.
 */

const open = async (path: string, channelsApi = new MockChannelsApi()) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    channelsApi,
    initialEntries: [path],
  });

  return { ...rendered, channelsApi };
};

const rowFor = (address: string): HTMLElement => {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(address) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${address}`);
  }

  return row;
};

describe('Channels › Mailboxes', () => {
  it('redirects /admin/channels to the Mailboxes tab and draws each health state', async () => {
    await open('/admin/channels');

    expect(await screen.findByText('support@helpdock.io', {}, SLOW)).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Mailboxes' })).toHaveAttribute('aria-selected', 'true');
    expect(within(rowFor('support@helpdock.io')).getByText('Healthy')).toBeVisible();
    expect(within(rowFor('billing@helpdock.io')).getByText('IMAP sign-in failed')).toBeVisible();
    expect(
      within(rowFor('billing@helpdock.io')).getByRole('link', { name: 'Fix billing@helpdock.io' }),
    ).toBeVisible();
    expect(within(rowFor('returns@helpdock.io')).getByText('Behind')).toBeVisible();
    expect(within(rowFor('hello@helpdock.io')).getByText(/Postmark/)).toBeVisible();
    expect(screen.getByText(/4 addresses/)).toBeVisible();
  });

  it('deletes a mailbox after asking', async () => {
    const { user } = await open('/admin/channels/mailboxes');
    await screen.findByText('returns@helpdock.io', {}, SLOW);

    await user.click(
      within(rowFor('returns@helpdock.io')).getByRole('button', {
        name: 'Actions for returns@helpdock.io',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete mailbox' }));

    await waitFor(() => {
      expect(screen.queryByText('returns@helpdock.io')).not.toBeInTheDocument();
    });
  });

  it('copies an endpoint, and shows a replaced secret exactly once', async () => {
    const { user } = await open('/admin/channels/mailboxes');
    await screen.findByText('Inbound parse endpoints', {}, SLOW);

    await user.click(screen.getByRole('button', { name: 'Copy the SendGrid URL' }));
    // user-event installs its own clipboard, so what was copied can be read back.
    expect(await navigator.clipboard.readText()).toMatch(/\/internal\/inbound-parse\/sendgrid$/);
    expect(screen.getByText(/Last request: Postmark/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.click(await screen.findByRole('button', { name: 'Replace secret' }));
    const reveal = await screen.findByRole('dialog', { name: 'Copy the new secret' });
    expect(within(reveal).getByLabelText('New shared secret')).toHaveValue(
      'hd_inbound_Qm9vdHN0cmFwLXNlY3JldC1zaG93bi1vbmNl',
    );
    await user.click(within(reveal).getByRole('button', { name: 'Copy secret' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue(/hd_inbound_/)).not.toBeInTheDocument();
    });
  });
});

describe('the mailbox form', { timeout: 60_000 }, () => {
  it('adds an IMAP mailbox after checking the fields, then opens it', async () => {
    const { user, channelsApi } = await open('/admin/channels/mailboxes/new');
    await screen.findByRole('heading', { name: 'Add mailbox', level: 1 }, SLOW);

    await user.click(screen.getByRole('button', { name: 'Add mailbox' }));
    expect(await screen.findAllByText('Required')).not.toHaveLength(0);
    expect(screen.getByText('An IMAP mailbox needs a password')).toBeVisible();

    await user.type(screen.getByLabelText('Email address'), 'Sales@Helpdock.io');
    await user.type(screen.getByLabelText('Display name'), 'Helpdock Sales');
    await user.type(screen.getByLabelText('IMAP host'), 'imap.fastmail.com');
    await user.type(screen.getByLabelText('Username'), 'sales@helpdock.io');
    await user.type(screen.getByLabelText('Password'), 'app-password');
    await user.type(
      screen.getByLabelText('Automated senders that may open tickets'),
      'alerts@statuspage.io',
    );
    await user.click(screen.getByRole('button', { name: 'Add mailbox' }));

    expect(
      await screen.findByRole('heading', { name: 'sales@helpdock.io', level: 1 }, SLOW),
    ).toBeVisible();
    const created = (await channelsApi.mailboxes()).mailboxes.find(
      (row) => row.address === 'sales@helpdock.io',
    );
    expect(created).toMatchObject({ method: 'imap', automatedAllowlist: ['alerts@statuspage.io'] });
  });

  it('keeps an address another mailbox has on the form, as a refusal', async () => {
    const { user } = await open('/admin/channels/mailboxes/new');
    await screen.findByRole('heading', { name: 'Add mailbox', level: 1 }, SLOW);

    await user.click(screen.getByRole('radio', { name: /Inbound parse webhook/ }));
    await user.type(screen.getByLabelText('Email address'), 'support@helpdock.io');
    await user.type(screen.getByLabelText('Display name'), 'Duplicate');
    await user.click(screen.getByRole('button', { name: 'Add mailbox' }));

    expect(await screen.findByRole('alert', {}, SLOW)).toHaveTextContent(
      'Another mailbox already receives mail for that address.',
    );
  });

  it('tests IMAP with the stored password, and draws what the server refused', async () => {
    const { user } = await open('/admin/channels/mailboxes/0192c3f0-1a2b-7c3d-8e4f-0000000000e1');
    expect(
      await screen.findByRole('heading', { name: 'billing@helpdock.io', level: 1 }, SLOW),
    ).toBeVisible();
    expect(screen.getByText(/IMAP sign-in failed since/)).toBeVisible();
    expect(screen.getByText(/Saved .* by Lina Haddad/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Test IMAP' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Connected to imap.fastmail.com:993',
    );
    expect(screen.getByRole('status')).toHaveTextContent('1,284 messages, 3 unread');

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Test IMAP' }));
    const refused = await screen.findByRole('alert');
    expect(refused).toHaveTextContent('IMAP refused the sign-in');
    expect(refused).toHaveTextContent('A1 NO [AUTHENTICATIONFAILED]');

    await user.clear(screen.getByLabelText('Folder'));
    await user.type(screen.getByLabelText('Folder'), 'Archive');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'right');
    await user.click(screen.getByRole('button', { name: 'Test IMAP' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No folder called Archive');

    await user.clear(screen.getByLabelText('IMAP host'));
    await user.type(screen.getByLabelText('IMAP host'), 'unreachable.example');
    await user.click(screen.getByRole('button', { name: 'Test IMAP' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No answer within 15 s');
  });

  it('saves a change, discards another, and deletes the mailbox', async () => {
    const { user, channelsApi } = await open(
      '/admin/channels/mailboxes/0192c3f0-1a2b-7c3d-8e4f-0000000000e4',
    );
    await screen.findByRole('heading', { name: 'support@helpdock.io', level: 1 }, SLOW);
    expect(screen.getByRole('button', { name: 'Save mailbox' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Load through the Helpdock image proxy/ }));
    await user.click(screen.getByRole('switch', { name: /SPF or DKIM/ }));
    expect(screen.getByText(/Unsaved changes/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save mailbox' }));
    await waitFor(async () => {
      expect(
        (await channelsApi.mailbox('', '0192c3f0-1a2b-7c3d-8e4f-0000000000e4')).remoteImages,
      ).toBe('proxy');
    });

    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Changed');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('Helpdock Support');

    await user.click(screen.getByRole('button', { name: 'Delete mailbox' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete mailbox' }));
    expect(await screen.findByRole('heading', { name: 'Channels', level: 1 }, SLOW)).toBeVisible();
  });

  it('says so when the mailbox does not exist', async () => {
    await open('/admin/channels/mailboxes/0192c3f0-1a2b-7c3d-8e4f-0000000000ff');

    expect(await screen.findByText('No such mailbox', {}, SLOW)).toBeVisible();
  });
});
