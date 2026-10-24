import type { Session } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../../app/routes.tsx';
import type { MockAuthApi } from '../../../../auth/mock-api.js';
import type { MetaApi } from '../../../../meta/api.js';
import { MetaError } from '../../../../meta/api.js';
import {
  MOCK_INSTAGRAM_TOKEN,
  MOCK_MESSENGER_TOKEN,
  MOCK_NEW_INSTAGRAM_ID,
  MOCK_NEW_MESSENGER_PAGE_ID,
  MOCK_NEW_WHATSAPP_PHONE_ID,
  MOCK_REFUSED_TOKEN,
  MOCK_WHATSAPP_TOKEN,
  MockMetaApi,
} from '../../../../meta/mock-api.js';
import { renderApp } from '../../../../test/render.tsx';
import { settingsLink } from '../../../../test/settings-nav.js';
import { signedInMockApis } from '../../../../test/signed-in.js';

/**
 * Channels › Meta against the fixture (M10-07, `Admin/Channels-Meta`): the app
 * card, the list with each account's subscription and health, the Connect
 * dialog and its refusals per platform, Disconnect behind its typed id, and the
 * empty state.
 */

const LOAD = { timeout: 5_000 };

/** Pastes rather than types: a 40-character token typed key by key is most of a test's time. */
const fill = async (
  user: ReturnType<typeof renderApp>['user'],
  field: HTMLElement,
  text: string,
): Promise<void> => {
  await user.click(field);
  await user.paste(text);
};

const renderMeta = async ({
  path = '/settings/channels/meta',
  metaApi = new MockMetaApi(),
  installAdmin = true,
}: {
  path?: string;
  metaApi?: MetaApi;
  installAdmin?: boolean;
} = {}) => {
  const apis = await signedInMockApis();
  const session = await apis.auth.me();
  if (session === null) {
    throw new Error('expected a session');
  }
  const changed: Session = { ...session, user: { ...session.user, installAdmin } };
  (apis.auth as MockAuthApi).me = async () => changed;
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    metaApi,
    initialEntries: [path],
  });
  return { ...rendered, metaApi };
};

/** The list once the fixture has answered: a row is an account with a link to its page. */
const table = async (): Promise<HTMLElement> => {
  const accounts = await screen.findByRole('table', { name: 'Connected accounts' }, LOAD);
  await within(accounts).findAllByRole('link', {}, LOAD);
  return accounts;
};

const row = (accounts: HTMLElement, name: string): HTMLElement => {
  const found = within(accounts)
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByRole('link', { name }) !== null);
  if (found === undefined) {
    throw new Error(`no row for ${name}`);
  }
  return found;
};

describe('Channels › Meta', () => {
  it('lists the accounts with where they route, their subscription and their health', async () => {
    await renderMeta();
    const accounts = await table();

    expect(settingsLink('WhatsApp, Messenger, Instagram')).toHaveAttribute('aria-current', 'page');
    const whatsapp = row(accounts, '+1 555 0142');
    expect(within(whatsapp).getByText('WhatsApp')).toBeVisible();
    expect(within(whatsapp).getByText('Helpdock Support')).toBeVisible();
    expect(within(whatsapp).getByText('Support')).toBeVisible();
    expect(within(whatsapp).getByText('Subscribed')).toBeVisible();
    expect(within(whatsapp).getByText('Healthy')).toBeVisible();

    const test = row(accounts, '+1 555 0100');
    expect(within(test).getByText('No message yet')).toBeVisible();
    expect(within(test).getByText('Waiting')).toBeVisible();

    const instagram = row(accounts, '@helpdock');
    expect(within(instagram).getByText('Onboarding')).toBeVisible();
    expect(within(instagram).getByText('Token expired')).toBeVisible();
    expect(within(instagram).getByText(/Not checked since/)).toBeVisible();
    expect(within(instagram).getByText(/Meta: “Error validating access token/)).toBeVisible();
    expect(within(instagram).getByRole('link', { name: 'Fix @helpdock' })).toBeVisible();

    expect(screen.getByRole('heading', { name: 'How messages arrive' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Health' })).toBeVisible();
  });

  it('shows the Meta app card to an install admin: the callback URL, the verify token, the locked secret', async () => {
    await renderMeta();
    await table();

    const card = await screen.findByRole('region', { name: 'Meta app' }, LOAD);
    expect(within(card).getByLabelText('Callback URL')).toHaveValue(
      'https://support.helpdock.io/api/meta/webhook',
    );
    expect(within(card).getByLabelText('Verify token ending in e2f7')).toHaveValue('•••• e2f7');
    expect(within(card).getByLabelText('App id')).toHaveValue('1290457718832406');
    expect(within(card).getByText('Set by environment')).toBeVisible();
    expect(within(card).getByLabelText('App secret')).toHaveAttribute('readonly');
    expect(within(card).getByLabelText('App secret')).toHaveValue('••••••••••••');
    expect(within(card).getByLabelText('Instagram app secret')).toHaveValue('Set');
    expect(within(card).getByLabelText('Graph API version')).toHaveValue('v25.0');
    expect(within(card).getByText(/Last signed event \d\d:\d\d/)).toBeVisible();
  });

  it('calls an account that is not subscribed or whose token is about to end by what is wrong', async () => {
    const metaApi = new MockMetaApi();
    const { accounts } = await metaApi.accounts('brand');
    const [instagram, messenger, whatsapp] = accounts;
    if (instagram === undefined || messenger === undefined || whatsapp === undefined) {
      throw new Error('the fixture has accounts of three platforms');
    }
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    vi.spyOn(metaApi, 'accounts').mockResolvedValue({
      accounts: [
        {
          ...instagram,
          status: 'connected',
          health: 'healthy',
          tokenExpiresAt: inThreeDays,
          lastError: null,
        },
        {
          ...messenger,
          status: 'unsubscribed',
          health: 'failing',
          subscribedAt: null,
          lastError: null,
        },
        { ...whatsapp, subscribedAt: null },
      ],
    });
    await renderMeta({ metaApi });
    const list = await table();

    const expiring = row(list, '@helpdock');
    expect(within(expiring).getByText('Expiring')).toBeVisible();
    expect(within(expiring).getByText(/^stops /)).toBeVisible();
    const dropped = row(list, 'Helpdock');
    expect(within(dropped).getByText('Not subscribed', { selector: 'div' })).toBeVisible();
    expect(within(dropped).getByRole('link', { name: 'Fix Helpdock' })).toBeVisible();
    expect(
      within(row(list, '+1 555 0142')).getByText('Not subscribed', { selector: 'div' }),
    ).toBeVisible();
  });

  it('copies the callback URL', async () => {
    const { user } = await renderMeta();
    const card = await screen.findByRole('region', { name: 'Meta app' }, LOAD);

    await user.click(within(card).getByRole('button', { name: 'Copy the callback URL' }));

    expect(await screen.findByText('Copied')).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe(
      'https://support.helpdock.io/api/meta/webhook',
    );
  });

  it('says which settings are not set, and keeps Connect off until a secret and a verify token are', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'accounts').mockResolvedValue({ accounts: [] });
    vi.spyOn(metaApi, 'app').mockResolvedValue({
      appIdSet: false,
      appId: '',
      appSecretSet: false,
      instagramAppSecretSet: false,
      graphVersion: 'v26.0',
      callbackUrl: 'https://support.helpdock.io/api/meta/webhook',
      verifyTokenHint: 'e2f7',
      secretsLockedByEnv: [],
    });
    await renderMeta({ metaApi });

    const card = await screen.findByRole('region', { name: 'Meta app' }, LOAD);
    expect(within(card).getByLabelText('App id')).toHaveValue('Not set');
    expect(within(card).getByLabelText('App secret')).toHaveValue('Not set');
    expect(within(card).getByLabelText('Instagram app secret')).toHaveValue('Not set');
    expect(within(card).getByLabelText('Graph API version')).toHaveValue('v26.0');
    expect(within(card).queryByText('Set by environment')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Connect account' })[1]).toBeDisabled();
  });

  it('keeps the Meta app card from anyone who is not an install admin', async () => {
    await renderMeta({ installAdmin: false });
    await table();

    expect(screen.queryByRole('region', { name: 'Meta app' })).toBeNull();
  });

  it('replaces the verify token only after a confirmation, and shows the new one once', async () => {
    const { user, metaApi } = await renderMeta();
    const rotate = vi.spyOn(metaApi, 'rotateVerifyToken');
    const card = await screen.findByRole('region', { name: 'Meta app' }, LOAD);

    await user.click(within(card).getByRole('button', { name: 'Replace…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Replace the verify token?' });
    expect(rotate).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Replace token' }));

    const reveal = await screen.findByRole('dialog', { name: 'Copy the verify token' });
    const shown = within(reveal).getByLabelText('Verify token');
    expect((shown as HTMLInputElement).value).toMatch(/^hd_mvt_/);
    expect(within(reveal).getByText('Shown only this once.')).toBeVisible();
    expect(within(reveal).getByText(/Meta dashboard › Webhooks/)).toBeVisible();
    const last4 = (shown as HTMLInputElement).value.slice(-4);

    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await within(card).findByLabelText(`Verify token ending in ${last4}`)).toBeVisible();
  });

  it('makes a verify token straight away when there is none, and says Connect waits for one', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'accounts').mockResolvedValue({ accounts: [] });
    vi.spyOn(metaApi, 'app').mockResolvedValue({
      appIdSet: true,
      appId: '1290457718832406',
      appSecretSet: true,
      instagramAppSecretSet: false,
      graphVersion: 'v25.0',
      callbackUrl: 'https://support.helpdock.io/api/meta/webhook',
      verifyTokenHint: '',
      secretsLockedByEnv: [],
    });
    await renderMeta({ metaApi });

    expect(
      await screen.findByRole('heading', { name: 'No Meta accounts yet' }, LOAD),
    ).toBeVisible();
    const buttons = screen.getAllByRole('button', { name: 'Connect account' });
    expect(buttons[1]).toBeDisabled();
    expect(buttons[1]).toHaveAccessibleDescription(
      /An install admin has to set the Meta app secret first/,
    );
    expect(screen.getByRole('button', { name: 'Make one' })).toBeVisible();
  });

  it('shows the empty state with what each platform asks for', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'accounts').mockResolvedValue({ accounts: [] });
    await renderMeta({ metaApi });

    expect(
      await screen.findByRole('heading', { name: 'No Meta accounts yet' }, LOAD),
    ).toBeVisible();
    const guide = screen.getByRole('table', { name: 'What each platform asks for' });
    expect(within(guide).getByText('Phone number id')).toBeVisible();
    expect(within(guide).getByText('Page access token')).toBeVisible();
    expect(within(guide).getByText('60 days, renewed')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Connect account' })).toHaveLength(2);
  });
});

describe('Connect a Meta account', () => {
  const openDialog = async (renderedUser: ReturnType<typeof renderApp>['user']) => {
    await table();
    await renderedUser.click(screen.getByRole('button', { name: 'Connect account' }));
    return screen.findByRole('dialog', { name: 'Connect a Meta account' });
  };

  it('keeps Connect off until Test succeeds, and says why a token was refused', async () => {
    const { user } = await renderMeta();
    const dialog = await openDialog(user);
    const connect = within(dialog).getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /WhatsApp/ })).toBeChecked();
    expect(within(dialog).queryByRole('note')).toBeNull();

    await fill(user, within(dialog).getByLabelText(/^Phone number id/), MOCK_NEW_WHATSAPP_PHONE_ID);
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_REFUSED_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));

    expect(
      await within(dialog).findByText(
        /Meta refused this token: “Invalid OAuth access token - Cannot parse access token \(190\)”/,
      ),
    ).toBeVisible();
    expect(within(dialog).getByLabelText(/^Access token/)).toHaveAttribute('aria-invalid', 'true');
    expect(connect).toBeDisabled();
  });

  it('checks the shape of the id and the token before asking Meta', async () => {
    const { user, metaApi } = await renderMeta();
    const testToken = vi.spyOn(metaApi, 'testToken');
    const dialog = await openDialog(user);

    await fill(user, within(dialog).getByLabelText(/^Phone number id/), '+1 555 0142');
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_WHATSAPP_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(
      await within(dialog).findByText('That is not an id from Meta. It is digits only.'),
    ).toBeVisible();

    await user.clear(within(dialog).getByLabelText(/^Phone number id/));
    await fill(user, within(dialog).getByLabelText(/^Phone number id/), MOCK_NEW_WHATSAPP_PHONE_ID);
    await user.clear(within(dialog).getByLabelText(/^Access token/));
    await fill(user, within(dialog).getByLabelText(/^Access token/), 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText(/does not look like a token from Meta/)).toBeVisible();
    expect(testToken).not.toHaveBeenCalled();
  });

  it('renames the id field and clears what was typed when the platform changes', async () => {
    const { user } = await renderMeta();
    const dialog = await openDialog(user);

    await fill(user, within(dialog).getByLabelText(/^Phone number id/), MOCK_NEW_WHATSAPP_PHONE_ID);
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_WHATSAPP_TOKEN);
    await user.click(within(dialog).getByRole('radio', { name: /Instagram/ }));

    expect(within(dialog).getByLabelText(/^Instagram account id/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/^Access token/)).toHaveValue('');
    expect(within(dialog).getByRole('note')).toHaveTextContent(/App Review\./);
    expect(within(dialog).getByRole('note')).toHaveTextContent(
      /instagram_business_manage_messages/,
    );

    await user.click(within(dialog).getByRole('radio', { name: /Messenger/ }));
    expect(within(dialog).getByLabelText(/^Page id/)).toBeVisible();
    expect(within(dialog).getByRole('note')).toHaveTextContent(/pages_messaging/);
  });

  it.each([
    {
      platform: /WhatsApp/,
      idLabel: /^Phone number id/,
      id: MOCK_NEW_WHATSAPP_PHONE_ID,
      token: MOCK_WHATSAPP_TOKEN,
      works: /Token works · “Helpdock 8204”/,
      listed: '+1 555 8204',
    },
    {
      platform: /Messenger/,
      idLabel: /^Page id/,
      id: MOCK_NEW_MESSENGER_PAGE_ID,
      token: MOCK_MESSENGER_TOKEN,
      works: /Token works · “Helpdock 0111”/,
      listed: 'Helpdock 0111',
    },
    {
      platform: /Instagram/,
      idLabel: /^Instagram account id/,
      id: MOCK_NEW_INSTAGRAM_ID,
      token: MOCK_INSTAGRAM_TOKEN,
      works: /Token works · “Helpdock 0111” · @helpdock_0111 · expires/,
      listed: '@helpdock_0111',
    },
  ])('connects $listed once its token works', async (scenario) => {
    const { user, metaApi } = await renderMeta();
    const create = vi.spyOn(metaApi, 'createAccount');
    const testToken = vi.spyOn(metaApi, 'testToken');
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('radio', { name: scenario.platform }));
    await fill(user, within(dialog).getByLabelText(scenario.idLabel), scenario.id);
    await fill(user, within(dialog).getByLabelText(/^Access token/), scenario.token);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(scenario.works);
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ externalId: scenario.id, accessToken: scenario.token }),
    );
    // A new connection names no account, so an id that is taken stays refused.
    expect(testToken.mock.calls[0]?.[1]).not.toHaveProperty('accountId');
    expect(within(await table()).getByRole('link', { name: scenario.listed })).toBeVisible();
  });

  it('refuses an account that is already connected, under the id field', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'testToken').mockRejectedValue(new MetaError('account-taken'));
    const { user } = await renderMeta({ metaApi });
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('radio', { name: /Messenger/ }));
    await fill(user, within(dialog).getByLabelText(/^Page id/), '104857223916604');
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_MESSENGER_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));

    expect(await within(dialog).findByText(/already connected on this install/)).toBeVisible();
    expect(within(dialog).getByLabelText(/^Page id/)).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('shows the api’s refusal when Connect is refused after a good Test', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'createAccount').mockRejectedValue(new MetaError('app-not-configured'));
    const { user } = await renderMeta({ metaApi });
    const dialog = await openDialog(user);

    await fill(user, within(dialog).getByLabelText(/^Phone number id/), MOCK_NEW_WHATSAPP_PHONE_ID);
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_WHATSAPP_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    await within(dialog).findByRole('status');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/no Meta app set up yet/);
  });

  it('says Meta could not be reached when the test fails without an answer', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'testToken').mockRejectedValue(new Error('network'));
    const { user } = await renderMeta({ metaApi });
    const dialog = await openDialog(user);

    await fill(user, within(dialog).getByLabelText(/^Phone number id/), MOCK_NEW_WHATSAPP_PHONE_ID);
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_WHATSAPP_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));

    expect(
      await within(dialog).findByText('Meta could not be reached. Try again in a moment.'),
    ).toBeVisible();
  });
});

describe('Disconnect from the list', () => {
  it('disconnects an account only once its id is typed exactly', async () => {
    const { user } = await renderMeta();
    const accounts = await table();

    await user.click(within(accounts).getByRole('button', { name: 'Actions for @helpdock' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Disconnect @helpdock from Instagram?',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Disconnect' });
    const typed = within(dialog).getByLabelText(/Type the Instagram account id 17841405822304914/);

    await fill(user, typed, '1784140582230491');
    expect(confirm).toBeDisabled();
    await user.clear(typed);
    await fill(user, typed, '17841405822304914');
    await user.click(confirm);

    await waitFor(() => {
      expect(within(accounts).queryByRole('link', { name: '@helpdock' })).toBeNull();
    });
  });

  it('opens an account’s page from the row menu', async () => {
    const { user } = await renderMeta();
    const accounts = await table();

    await user.click(within(accounts).getByRole('button', { name: 'Actions for Helpdock' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open' }));

    expect(await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD)).toBeVisible();
  });
});
