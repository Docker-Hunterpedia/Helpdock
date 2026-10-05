import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../../app/routes.tsx';
import type { TelegramApi } from '../../../../telegram/api.js';
import { TelegramError } from '../../../../telegram/api.js';
import {
  MOCK_BILLING_BOT,
  MOCK_GOOD_TOKEN,
  MOCK_REFUSED_TOKEN,
  MOCK_SUPPORT_BOT,
  MockTelegramApi,
} from '../../../../telegram/mock-api.js';
import { renderApp } from '../../../../test/render.tsx';
import { signedInMockApis } from '../../../../test/signed-in.js';

/**
 * Channels › Telegram against the fixture (M6-05, `Admin/Channels-Telegram`):
 * the list with each bot's webhook and health, the Add bot dialog and its
 * refused-token path, a bot's page — Replace, Test connection, Set webhook,
 * Save — and Delete behind its typed confirmation.
 */

const LOAD = { timeout: 5_000 };

/** Pastes rather than types: a 46-character token typed key by key is most of a test's time. */
const fill = async (
  user: ReturnType<typeof renderApp>['user'],
  field: HTMLElement,
  text: string,
): Promise<void> => {
  await user.click(field);
  await user.paste(text);
};

const renderTelegram = async (
  path = '/admin/channels/telegram',
  telegramApi: TelegramApi = new MockTelegramApi(),
) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    telegramApi,
    initialEntries: [path],
  });
  return { ...rendered, telegramApi };
};

/** The list once the fixture has answered: a row is a bot with a link to its page. */
const table = async (): Promise<HTMLElement> => {
  const bots = await screen.findByRole('table', { name: 'Telegram bots' }, LOAD);
  await within(bots).findAllByRole('link', {}, LOAD);
  return bots;
};

describe('Channels › Telegram', () => {
  it('lists the bots with where they route, their webhook and their health', async () => {
    await renderTelegram();
    const bots = await table();

    expect(screen.getByRole('tab', { name: 'Telegram' })).toHaveAttribute('aria-selected', 'true');
    const [, billing, support] = within(bots).getAllByRole('row');
    expect(within(support as HTMLElement).getByText('@helpdock_support_bot')).toBeVisible();
    expect(within(support as HTMLElement).getByText('Healthy')).toBeVisible();
    expect(within(support as HTMLElement).getByText('Set')).toBeVisible();
    expect(within(billing as HTMLElement).getByText('Billing')).toBeVisible();
    expect(within(billing as HTMLElement).getByText('Failing')).toBeVisible();
    expect(
      within(billing as HTMLElement).getByText(/Wrong response from the webhook: 401/),
    ).toBeVisible();
    expect(
      within(billing as HTMLElement).getByRole('link', { name: 'Fix @helpdock_billing_bot' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'How updates arrive' })).toBeVisible();
  });

  it('keeps Add bot off until Test succeeds, and says why a token was refused', async () => {
    const { user } = await renderTelegram();
    await table();

    await user.click(screen.getByRole('button', { name: 'Add bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a Telegram bot' });
    const add = within(dialog).getByRole('button', { name: 'Add bot' });
    expect(add).toBeDisabled();

    await fill(user, within(dialog).getByLabelText(/^Bot token/), MOCK_REFUSED_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(
      await within(dialog).findByText(/Telegram refused this token \(401: Unauthorized\)/),
    ).toBeVisible();
    expect(within(dialog).getByLabelText(/^Bot token/)).toHaveAttribute('aria-invalid', 'true');
    expect(add).toBeDisabled();

    await user.clear(within(dialog).getByLabelText(/^Bot token/));
    await fill(user, within(dialog).getByLabelText(/^Bot token/), 'not a token');
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText(/That is not a BotFather token/)).toBeVisible();
  });

  it('adds a bot once its token works, sets its webhook and lists it', async () => {
    const { user, telegramApi } = await renderTelegram();
    const setWebhook = vi.spyOn(telegramApi, 'setWebhook');
    await table();

    await user.click(screen.getByRole('button', { name: 'Add bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a Telegram bot' });
    await fill(user, within(dialog).getByLabelText(/^Bot token/), MOCK_GOOD_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      'Token works · @helpdock_2299_bot',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add bot' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await within(await table()).findByText('@helpdock_2299_bot')).toBeVisible();
    expect(setWebhook).toHaveBeenCalledTimes(1);
  });

  it('shows the api’s refusal when the bot is already connected', async () => {
    const telegramApi = new MockTelegramApi();
    vi.spyOn(telegramApi, 'createBot').mockRejectedValue(new TelegramError('bot-taken'));
    const { user } = await renderTelegram(undefined, telegramApi);
    await table();

    await user.click(screen.getByRole('button', { name: 'Add bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a Telegram bot' });
    await fill(user, within(dialog).getByLabelText(/^Bot token/), MOCK_GOOD_TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    await within(dialog).findByRole('status');
    await user.click(within(dialog).getByRole('button', { name: 'Add bot' }));

    expect(await within(dialog).findByText(/already connected to a brand/)).toBeVisible();
  });

  it('deletes a bot only once its name is typed exactly', async () => {
    const { user } = await renderTelegram();
    const bots = await table();

    await user.click(
      within(bots).getByRole('button', { name: 'Actions for @helpdock_billing_bot' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete @helpdock_billing_bot?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete bot' });

    await fill(
      user,
      within(dialog).getByLabelText(/Type @helpdock_billing_bot/),
      '@helpdock_billing',
    );
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/Type @helpdock_billing_bot/));
    await fill(
      user,
      within(dialog).getByLabelText(/Type @helpdock_billing_bot/),
      '@helpdock_billing_bot',
    );
    await user.click(confirm);

    await waitFor(() => {
      expect(within(bots).queryByText('@helpdock_billing_bot')).toBeNull();
    });
  });

  it('shows the empty state when the brand has no bot', async () => {
    const telegramApi = new MockTelegramApi();
    vi.spyOn(telegramApi, 'bots').mockResolvedValue({ bots: [] });
    await renderTelegram(undefined, telegramApi);

    expect(
      await screen.findByRole('heading', { name: 'No Telegram bots yet' }, LOAD),
    ).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Add bot' })).toHaveLength(2);
  });
});

describe('a Telegram bot’s page', () => {
  it('shows the token as its last four characters, tests the connection and sets the webhook', async () => {
    const { user, telegramApi } = await renderTelegram(
      `/admin/channels/telegram/${MOCK_SUPPORT_BOT}`,
    );
    const setWebhook = vi.spyOn(telegramApi, 'setWebhook');

    const token = await screen.findByLabelText('Saved token ending in 4f2a', {}, LOAD);
    expect(token).toHaveValue('•••• 4f2a');
    expect(token).toHaveAttribute('readonly');

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const connected = await screen.findByText(/^Connected · /);
    expect(connected.closest('[role="status"]')).toHaveTextContent(
      'getMe returned @helpdock_support_bot · “Helpdock Support” · id 7310042215',
    );

    expect(await screen.findByText('Pending updates')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Set webhook' }));
    await waitFor(() => {
      expect(setWebhook).toHaveBeenCalledWith(expect.any(String), MOCK_SUPPORT_BOT);
    });

    expect(screen.getByRole('region', { name: 'Activity' })).toHaveTextContent('14');
  });

  it('saves the department, the welcome and a replaced token together', async () => {
    const { user, telegramApi } = await renderTelegram(
      `/admin/channels/telegram/${MOCK_SUPPORT_BOT}`,
    );
    const update = vi.spyOn(telegramApi, 'updateBot');
    await screen.findByLabelText('Saved token ending in 4f2a', {}, LOAD);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await fill(user, screen.getByLabelText('Bot token'), 'nope');
    await user.click(save);
    expect(await screen.findByText(/That is not a BotFather token/)).toBeVisible();
    expect(update).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Bot token'));
    await fill(
      user,
      screen.getByLabelText('Bot token'),
      '7310042215:AAEreplacedTokenAbcdefghijklmn9z9z',
    );
    await user.clear(screen.getByLabelText('Welcome · Arabic'));
    await user.click(
      screen.getByRole('switch', { name: 'Offer English and العربية buttons with the welcome' }),
    );
    await user.click(save);

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.any(String),
        MOCK_SUPPORT_BOT,
        expect.objectContaining({
          welcomeAr: null,
          languagePick: false,
          token: '7310042215:AAEreplacedTokenAbcdefghijklmn9z9z',
        }),
      );
    });
    expect(await screen.findByLabelText('Saved token ending in 9z9z')).toBeVisible();
  });

  it('says a token of another bot is refused, in the footer', async () => {
    const { user } = await renderTelegram(`/admin/channels/telegram/${MOCK_BILLING_BOT}`);
    await screen.findByLabelText('Saved token ending in 91c0', {}, LOAD);

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await fill(user, screen.getByLabelText('Bot token'), MOCK_GOOD_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/belongs to a different bot/);
  });

  it('deletes the bot from its page and goes back to the list', async () => {
    const { user } = await renderTelegram(`/admin/channels/telegram/${MOCK_BILLING_BOT}`);
    await screen.findByLabelText('Saved token ending in 91c0', {}, LOAD);

    await user.click(screen.getByRole('button', { name: 'Delete bot…' }));
    const dialog = await screen.findByRole('dialog');
    await fill(user, within(dialog).getByRole('textbox'), '@helpdock_billing_bot');
    await user.click(within(dialog).getByRole('button', { name: 'Delete bot' }));

    const bots = await table();
    await waitFor(() => {
      expect(within(bots).queryByText('@helpdock_billing_bot')).toBeNull();
    });
  });

  it('says so when the bot is gone', async () => {
    await renderTelegram('/admin/channels/telegram/0192c3f0-1a2b-7c3d-8e4f-0000000007ff');

    expect(await screen.findByRole('heading', { name: 'This bot is gone' }, LOAD)).toBeVisible();
  });
});
