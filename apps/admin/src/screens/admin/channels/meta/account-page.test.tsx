import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../../app/routes.tsx';
import type { MetaApi } from '../../../../meta/api.js';
import { MetaError } from '../../../../meta/api.js';
import {
  MOCK_INSTAGRAM_ACCOUNT,
  MOCK_INSTAGRAM_TOKEN,
  MOCK_MESSENGER_ACCOUNT,
  MOCK_MESSENGER_TOKEN,
  MOCK_REFUSED_TOKEN,
  MOCK_WHATSAPP_ACCOUNT,
  MockMetaApi,
} from '../../../../meta/mock-api.js';
import { renderApp } from '../../../../test/render.tsx';
import { signedInMockApis } from '../../../../test/signed-in.js';

/**
 * A Meta account's page against the fixture (M10-07, `Admin/Channels-Meta-
 * Account`): the Messenger Page with its Human Agent switch, the WhatsApp
 * number without one, and the Instagram account whose token Meta invalidated —
 * Reconnect, Test connection, Subscribe now, Save and Disconnect.
 */

const LOAD = { timeout: 5_000 };

const fill = async (
  user: ReturnType<typeof renderApp>['user'],
  field: HTMLElement,
  text: string,
): Promise<void> => {
  await user.click(field);
  await user.paste(text);
};

const renderAccount = async (accountId: string, metaApi: MetaApi = new MockMetaApi()) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    metaApi,
    initialEntries: [`/admin/channels/meta/${accountId}`],
  });
  return { ...rendered, metaApi };
};

describe('a Messenger Page’s page', () => {
  it('shows the token as its last four characters, tests the connection and subscribes again', async () => {
    const { user, metaApi } = await renderAccount(MOCK_MESSENGER_ACCOUNT);
    const subscribe = vi.spyOn(metaApi, 'subscribe');

    const token = await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);
    expect(token).toHaveValue('•••• 8KQZ');
    expect(token).toHaveAttribute('readonly');
    expect(screen.getByRole('heading', { name: 'Helpdock', level: 2 })).toBeVisible();
    expect(screen.getByText('Page access token')).toBeVisible();
    expect(screen.getByText('Never')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const connected = await screen.findByText(/^Connected · /);
    expect(connected.closest('[role="status"]')).toHaveTextContent(
      'the token belongs to “Helpdock” · id 104857223916604',
    );

    expect(await screen.findByText('message_echoes')).toBeVisible();
    expect(screen.getByText('Subscribed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Subscribe now' }));
    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledWith(expect.any(String), MOCK_MESSENGER_ACCOUNT);
    });
    expect(await screen.findByText('Meta app subscribed to Helpdock')).toBeVisible();
  });

  it('shows what happened lately in the Activity card', async () => {
    await renderAccount(MOCK_MESSENGER_ACCOUNT);
    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);

    const activity = await screen.findByRole('region', { name: 'Activity' });
    await waitFor(() => {
      expect(
        within(activity).getByText('Open tickets from this Page').nextSibling,
      ).toHaveTextContent('9');
    });
    expect(within(activity).getByText('Failed sends, 24 h').nextSibling).toHaveTextContent('1');
    expect(
      within(activity).getByText('Refused, window closed, 24 h').nextSibling,
    ).toHaveTextContent('2');
    expect(
      within(activity).getByRole('link', { name: 'View failed jobs in System' }),
    ).toBeVisible();
  });

  it('saves the department, the Human Agent switch and a replaced token together', async () => {
    const { user, metaApi } = await renderAccount(MOCK_MESSENGER_ACCOUNT);
    const update = vi.spyOn(metaApi, 'updateAccount');
    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(
      screen.getByRole('switch', {
        name: 'Allow a person to reply for 7 days instead of 24 hours',
      }),
    ).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await fill(user, screen.getByLabelText('Access token'), 'nope');
    await user.click(save);
    expect(await screen.findByText(/does not look like a token from Meta/)).toBeVisible();
    expect(update).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Access token'));
    await fill(user, screen.getByLabelText('Access token'), MOCK_MESSENGER_TOKEN);
    await user.click(
      screen.getByRole('switch', {
        name: 'Allow a person to reply for 7 days instead of 24 hours',
      }),
    );
    await user.click(save);

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.any(String),
        MOCK_MESSENGER_ACCOUNT,
        expect.objectContaining({
          humanAgentEnabled: true,
          accessToken: MOCK_MESSENGER_TOKEN,
        }),
      );
    });
    expect(
      await screen.findByLabelText(`Saved token ending in ${MOCK_MESSENGER_TOKEN.slice(-4)}`),
    ).toBeVisible();
    expect(screen.getByText('Helpdock saved')).toBeVisible();
    expect(
      screen.getByRole('switch', {
        name: 'Allow a person to reply for 7 days instead of 24 hours',
      }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('says a token of another account is refused, in the footer, and keeps the draft', async () => {
    const { user } = await renderAccount(MOCK_MESSENGER_ACCOUNT);
    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await fill(user, screen.getByLabelText('Access token'), `${MOCK_MESSENGER_TOKEN}OTHER`);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/belongs to a different account/);
    expect(screen.getByLabelText('Access token')).toHaveValue(`${MOCK_MESSENGER_TOKEN}OTHER`);
  });

  it('says Meta refused the subscription, in Meta’s words', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'subscribe').mockResolvedValue({
      ok: false,
      detail: '(#200) Requires pages_manage_metadata',
    });
    const { user } = await renderAccount(MOCK_MESSENGER_ACCOUNT, metaApi);
    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);

    await user.click(screen.getByRole('button', { name: 'Subscribe now' }));

    expect(
      await screen.findByText(
        'Meta refused the subscription: (#200) Requires pages_manage_metadata',
      ),
    ).toBeVisible();
  });

  it('says Meta could not be asked when the live read failed', async () => {
    const metaApi = new MockMetaApi();
    const status = await metaApi.status('brand', MOCK_MESSENGER_ACCOUNT);
    vi.spyOn(metaApi, 'status').mockResolvedValue({
      ...status,
      tokenValid: null,
      subscribedApps: null,
      liveError: 'timeout after 10 s',
    });
    await renderAccount(MOCK_MESSENGER_ACCOUNT, metaApi);

    expect(await screen.findByText('Meta could not be asked: timeout after 10 s')).toBeVisible();
  });

  it('keeps working while Meta is being asked, with the facts the list already has', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'status').mockReturnValue(new Promise(() => undefined));
    await renderAccount(MOCK_MESSENGER_ACCOUNT, metaApi);

    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);
    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(within(activity).getByText('Open tickets from this Page').nextSibling).toHaveTextContent(
      '—',
    );
    expect(screen.getAllByText('Not checked').length).toBeGreaterThan(0);
  });

  it('discards what was changed', async () => {
    const { user } = await renderAccount(MOCK_MESSENGER_ACCOUNT);
    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);
    const humanAgent = screen.getByRole('switch', {
      name: 'Allow a person to reply for 7 days instead of 24 hours',
    });

    await user.click(humanAgent);
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(humanAgent).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says it was not saved when the api fails', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'updateAccount').mockRejectedValue(new Error('503'));
    const { user } = await renderAccount(MOCK_MESSENGER_ACCOUNT, metaApi);
    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);

    await user.click(
      screen.getByRole('switch', {
        name: 'Allow a person to reply for 7 days instead of 24 hours',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('That did not work. Try again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('disconnects from its page, by its id, and goes back to the list', async () => {
    const { user } = await renderAccount(MOCK_MESSENGER_ACCOUNT);
    await screen.findByLabelText('Saved token ending in 8KQZ', {}, LOAD);

    await user.click(screen.getByRole('button', { name: 'Disconnect…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Disconnect Helpdock from Messenger?',
    });
    await fill(user, within(dialog).getByRole('textbox'), '104857223916604');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    const accounts = await screen.findByRole('table', { name: 'Connected accounts' }, LOAD);
    await waitFor(() => {
      expect(within(accounts).queryByRole('link', { name: 'Helpdock' })).toBeNull();
    });
  });
});

describe('a WhatsApp number’s page', () => {
  it('has the Number section and its notes, and no Human Agent', async () => {
    await renderAccount(MOCK_WHATSAPP_ACCOUNT);

    await screen.findByLabelText('Saved token ending in 3fa9', {}, LOAD);
    expect(screen.getByRole('heading', { name: 'Number' })).toBeVisible();
    expect(screen.getByText('Meta may charge for replies.')).toBeVisible();
    expect(screen.getByText('No Human Agent on WhatsApp.')).toBeVisible();
    expect(screen.getAllByRole('note')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Human Agent' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('System-user token')).toBeVisible();
    expect(
      screen.getByText('The department applies from the next new conversation.'),
    ).toBeVisible();
  });
});

describe('an Instagram account whose token Meta invalidated', () => {
  it('says what Meta said and reconnects with a token that tests well', async () => {
    const { user, metaApi } = await renderAccount(MOCK_INSTAGRAM_ACCOUNT);
    const update = vi.spyOn(metaApi, 'updateAccount');
    await screen.findByLabelText('Saved token ending in Qw7L', {}, LOAD);

    expect(screen.getByRole('alert')).toHaveTextContent(
      /Messages from @helpdock have stopped and replies cannot be sent until you reconnect\. Meta: “Error validating access token/,
    );
    expect(screen.getByText(/^Invalidated /)).toBeVisible();
    expect(screen.getAllByText('Not checked').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconnect @helpdock' });
    const reconnect = within(dialog).getByRole('button', { name: 'Reconnect' });
    expect(reconnect).toBeDisabled();

    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_REFUSED_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText(/Meta refused this token/)).toBeVisible();
    expect(reconnect).toBeDisabled();

    await user.clear(within(dialog).getByLabelText(/^Access token/));
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_INSTAGRAM_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      /Token works · “Helpdock” · @helpdock · expires/,
    );
    await user.click(reconnect);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      MOCK_INSTAGRAM_ACCOUNT,
      expect.objectContaining({ accessToken: MOCK_INSTAGRAM_TOKEN }),
    );
    expect(await screen.findByText('@helpdock reconnected')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    });
    expect(screen.queryByText(/^Invalidated /)).toBeNull();
  });

  it('answers Test connection with Meta’s refusal rather than an error', async () => {
    const { user } = await renderAccount(MOCK_INSTAGRAM_ACCOUNT);
    await screen.findByLabelText('Saved token ending in Qw7L', {}, LOAD);

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    const refused = await screen.findByText(/^Meta refused the saved token · /);
    expect(refused.closest('[role="alert"]')).toHaveTextContent(/Error validating access token/);
  });

  it('keeps Meta’s refusal of the new token in the dialog when the account does not match', async () => {
    const metaApi = new MockMetaApi();
    vi.spyOn(metaApi, 'updateAccount').mockRejectedValue(new MetaError('token-other-account'));
    const { user } = await renderAccount(MOCK_INSTAGRAM_ACCOUNT, metaApi);
    await screen.findByLabelText('Saved token ending in Qw7L', {}, LOAD);

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconnect @helpdock' });
    await fill(user, within(dialog).getByLabelText(/^Access token/), MOCK_INSTAGRAM_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    await within(dialog).findByRole('status');
    await user.click(within(dialog).getByRole('button', { name: 'Reconnect' }));

    expect(await within(dialog).findByText(/belongs to a different account/)).toBeVisible();
  });
});

describe('a Meta account that is gone', () => {
  it('says so', async () => {
    await renderAccount('0192c3f0-1a2b-7c3d-8e4f-0000000008ff');

    expect(
      await screen.findByRole('heading', { name: 'This account is gone' }, LOAD),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Meta accounts' })).toBeVisible();
  });
});
