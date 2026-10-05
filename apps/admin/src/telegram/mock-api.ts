import {
  TELEGRAM_SEND_ATTEMPTS,
  TELEGRAM_TOKEN_HINT_LENGTH,
  type TelegramBot,
  type TelegramBotCreateRequest,
  type TelegramBotList,
  type TelegramBotStatus,
  type TelegramBotUpdateRequest,
  type TelegramDelivery,
  type TelegramTestResult,
  type TelegramTicketContextResponse,
  type TelegramWebhookResult,
  telegramWebhookPath,
} from '@helpdock/schemas';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import {
  MOCK_TELEGRAM_REPLY_FAILED,
  MOCK_TELEGRAM_REPLY_SENT,
  MOCK_TICKET_ARABIC,
} from '../tickets/mock-api.js';
import { type TelegramApi, TelegramError } from './api.js';

/**
 * The fixture behind Channels › Telegram and the Telegram ticket in the unit
 * tests and the mock Playwright projects: the two bots of the
 * `Admin/Channels-Telegram` artboard — one healthy, one whose webhook Telegram
 * reports failing — and the chat of `Admin/Ticket-Telegram`.
 *
 * | Token typed | Test answers |
 * |---|---|
 * | secret part starting `AAE` | the token works; the bot is named after its id |
 * | anything else that looks like a token | 401 Unauthorized |
 */

const [SUPPORT, BILLING] = MOCK_DEPARTMENTS;
const ADMIN_NAME = 'Lina Haddad';
const APP_URL = 'https://support.helpdock.io';

export const MOCK_SUPPORT_BOT = '0192c3f0-1a2b-7c3d-8e4f-0000000007b1';
export const MOCK_BILLING_BOT = '0192c3f0-1a2b-7c3d-8e4f-0000000007b2';
/** What "Test" accepts in the Add bot dialog. */
export const MOCK_GOOD_TOKEN = '7310042299:AAEnewBotTokenForTheFixtureAbcdefgh';
/** What it refuses with Telegram's 401. */
export const MOCK_REFUSED_TOKEN = '7310042298:XXrevokedTokenForTheFixtureAbcdefg';

const KNOWN_USERNAMES: Readonly<Record<string, string>> = {
  '7310042215': 'helpdock_support_bot',
  '7310042216': 'helpdock_billing_bot',
};

const minutesAgo = (now: number, minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const identify = (token: string): { id: number; username: string } | undefined => {
  const [id = '', secret = ''] = token.split(':');
  if (!secret.startsWith('AAE')) {
    return undefined;
  }
  return { id: Number(id), username: KNOWN_USERNAMES[id] ?? `helpdock_${id.slice(-4)}_bot` };
};

interface StoredBot {
  bot: TelegramBot;
  telegramId: number;
}

const departmentName = (id: string): string =>
  MOCK_DEPARTMENTS.find((department) => department.id === id)?.name ?? '';

export class MockTelegramApi implements TelegramApi {
  readonly #bots = new Map<string, StoredBot>();
  readonly #deliveries: TelegramDelivery[];
  readonly #now: () => number;
  #sequence = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    const at = now();
    this.#bots.set(MOCK_SUPPORT_BOT, {
      telegramId: 7_310_042_215,
      bot: this.#row(MOCK_SUPPORT_BOT, {
        username: 'helpdock_support_bot',
        displayName: 'Helpdock Support',
        departmentId: SUPPORT?.id ?? '',
        tokenHint: '4f2a',
        welcome: {
          en: 'Hi! This is Helpdock support. Send us your question, a photo or a document, and someone from our team will reply here.',
          ar: 'مرحباً! هنا دعم Helpdock. أرسل سؤالك أو صورة أو مستنداً، وسيرد عليك أحد أعضاء فريقنا هنا.',
        },
        webhook: {
          url: `${APP_URL}${telegramWebhookPath(MOCK_SUPPORT_BOT)}`,
          setAt: minutesAgo(at, 3 * 24 * 60),
          expectedUrl: `${APP_URL}${telegramWebhookPath(MOCK_SUPPORT_BOT)}`,
        },
        health: {
          state: 'healthy',
          lastUpdateAt: minutesAgo(at, 2),
          lastError: null,
          lastErrorAt: null,
        },
      }),
    });
    this.#bots.set(MOCK_BILLING_BOT, {
      telegramId: 7_310_042_216,
      bot: this.#row(MOCK_BILLING_BOT, {
        username: 'helpdock_billing_bot',
        displayName: 'Helpdock Billing',
        departmentId: BILLING?.id ?? '',
        tokenHint: '91c0',
        webhook: {
          url: `${APP_URL}${telegramWebhookPath(MOCK_BILLING_BOT)}`,
          setAt: minutesAgo(at, 5 * 24 * 60),
          expectedUrl: `${APP_URL}${telegramWebhookPath(MOCK_BILLING_BOT)}`,
        },
        health: {
          state: 'failing',
          lastUpdateAt: minutesAgo(at, 3 * 60),
          lastError: 'Wrong response from the webhook: 401 Unauthorized',
          lastErrorAt: minutesAgo(at, 34),
        },
      }),
    });
    this.#deliveries = [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-0000000007d1',
        messageId: MOCK_TELEGRAM_REPLY_SENT,
        status: 'sent',
        attempts: 0,
        maxAttempts: TELEGRAM_SEND_ATTEMPTS,
        lastError: null,
        sentAt: minutesAgo(at, 3 * 60),
        failedAt: null,
      },
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-0000000007d2',
        messageId: MOCK_TELEGRAM_REPLY_FAILED,
        status: 'failed',
        attempts: TELEGRAM_SEND_ATTEMPTS,
        maxAttempts: TELEGRAM_SEND_ATTEMPTS,
        lastError: '403: Forbidden: bot was blocked by the user',
        sentAt: null,
        failedAt: minutesAgo(at, 90),
      },
    ];
  }

  async bots(_brandId: string): Promise<TelegramBotList> {
    await sleep();
    return {
      bots: [...this.#bots.values()]
        .map(({ bot }) => bot)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }

  async bot(_brandId: string, botId: string): Promise<TelegramBot> {
    await sleep();
    return this.#require(botId).bot;
  }

  async createBot(_brandId: string, request: TelegramBotCreateRequest): Promise<TelegramBot> {
    await sleep();
    const identity = identify(request.token);
    if (identity === undefined) {
      throw new TelegramError('token-invalid');
    }
    if ([...this.#bots.values()].some((stored) => stored.telegramId === identity.id)) {
      throw new TelegramError('bot-taken');
    }
    this.#sequence += 1;
    const id = `0192c3f0-1a2b-7c3d-8e4f-0000000007c${this.#sequence.toString(16)}`;
    const bot = this.#row(id, {
      username: identity.username,
      displayName: request.displayName,
      departmentId: request.departmentId,
      tokenHint: request.token.slice(-TELEGRAM_TOKEN_HINT_LENGTH),
      welcome: { en: request.welcomeEn, ar: request.welcomeAr },
      languagePick: request.languagePick,
    });
    this.#bots.set(id, { bot, telegramId: identity.id });
    return bot;
  }

  async updateBot(
    _brandId: string,
    botId: string,
    request: TelegramBotUpdateRequest,
  ): Promise<TelegramBot> {
    await sleep();
    const stored = this.#require(botId);
    if (request.token !== undefined) {
      const identity = identify(request.token);
      if (identity === undefined) {
        throw new TelegramError('token-invalid');
      }
      if (identity.id !== stored.telegramId) {
        throw new TelegramError('token-other-bot');
      }
    }
    const blank = (value: string | null): string | null =>
      value === null || value.trim() === '' ? null : value;
    stored.bot = {
      ...stored.bot,
      displayName: request.displayName,
      departmentId: request.departmentId,
      departmentName: departmentName(request.departmentId),
      welcome: { en: blank(request.welcomeEn), ar: blank(request.welcomeAr) },
      languagePick: request.languagePick,
      ...(request.token === undefined
        ? {}
        : {
            tokenHint: request.token.slice(-TELEGRAM_TOKEN_HINT_LENGTH),
            tokenUpdatedAt: new Date(this.#now()).toISOString(),
            tokenUpdatedByName: ADMIN_NAME,
          }),
    };
    return stored.bot;
  }

  async deleteBot(_brandId: string, botId: string): Promise<void> {
    await sleep();
    this.#require(botId);
    this.#bots.delete(botId);
  }

  async testToken(_brandId: string, token: string): Promise<TelegramTestResult> {
    await sleep();
    const identity = identify(token);
    return identity === undefined
      ? { ok: false, kind: 'token', detail: '401: Unauthorized' }
      : {
          ok: true,
          username: identity.username,
          name: identity.username,
          telegramId: identity.id,
        };
  }

  async testBot(_brandId: string, botId: string): Promise<TelegramTestResult> {
    await sleep();
    const { bot, telegramId } = this.#require(botId);
    return { ok: true, username: bot.username, name: bot.displayName, telegramId };
  }

  async setWebhook(_brandId: string, botId: string): Promise<TelegramWebhookResult> {
    await sleep();
    const stored = this.#require(botId);
    const setAt = new Date(this.#now()).toISOString();
    stored.bot = {
      ...stored.bot,
      webhook: { ...stored.bot.webhook, url: stored.bot.webhook.expectedUrl, setAt },
      health: { ...stored.bot.health, state: 'healthy', lastError: null, lastErrorAt: null },
    };
    return { ok: true, url: stored.bot.webhook.expectedUrl, setAt };
  }

  async status(_brandId: string, botId: string): Promise<TelegramBotStatus> {
    await sleep();
    const { bot } = this.#require(botId);
    const failing = bot.health.state === 'failing';
    return {
      health: bot.health,
      mode: bot.mode,
      webhook:
        bot.webhook.url === null
          ? null
          : {
              url: bot.webhook.url,
              pendingUpdateCount: failing ? 6 : 0,
              lastErrorAt: failing ? bot.health.lastErrorAt : null,
              lastErrorMessage: failing ? bot.health.lastError : null,
            },
      webhookError: null,
      activity: {
        lastReplyAt: botId === MOCK_SUPPORT_BOT ? minutesAgo(this.#now(), 1) : null,
        failedSends24h: botId === MOCK_SUPPORT_BOT ? 1 : 0,
        openTickets: botId === MOCK_SUPPORT_BOT ? 14 : 6,
      },
    };
  }

  async ticketContext(_brandId: string, ticketId: string): Promise<TelegramTicketContextResponse> {
    await sleep();
    if (ticketId !== MOCK_TICKET_ARABIC) {
      return { context: null, deliveries: [] };
    }
    return {
      context: {
        bot: { id: MOCK_SUPPORT_BOT, username: 'helpdock_support_bot' },
        chatId: '884413201',
        username: 'sara_h',
        name: 'سارة الحسن',
        locale: 'ar',
        languageChosenAt: minutesAgo(this.#now(), 3 * 24 * 60),
      },
      deliveries: this.#deliveries.map((delivery) => ({ ...delivery })),
    };
  }

  async retryDelivery(_brandId: string, ticketId: string, deliveryId: string): Promise<void> {
    await sleep();
    const delivery = this.#deliveries.find((candidate) => candidate.id === deliveryId);
    if (ticketId !== MOCK_TICKET_ARABIC || delivery === undefined) {
      throw new Error(`no such delivery: ${deliveryId}`);
    }
    Object.assign(delivery, {
      status: 'sent',
      attempts: 0,
      lastError: null,
      failedAt: null,
      sentAt: new Date(this.#now()).toISOString(),
    } satisfies Partial<TelegramDelivery>);
  }

  #require(botId: string): StoredBot {
    const stored = this.#bots.get(botId);
    if (stored === undefined) {
      throw new Error(`no such bot: ${botId}`);
    }
    return stored;
  }

  #row(
    id: string,
    fields: Pick<TelegramBot, 'username' | 'displayName' | 'departmentId' | 'tokenHint'> &
      Partial<TelegramBot>,
  ): TelegramBot {
    const created = '2026-10-02T09:00:00.000Z';
    return {
      id,
      departmentName: departmentName(fields.departmentId),
      tokenSet: true,
      tokenUpdatedAt: created,
      tokenUpdatedByName: ADMIN_NAME,
      welcome: { en: null, ar: null },
      languagePick: true,
      webhook: { url: null, setAt: null, expectedUrl: `${APP_URL}${telegramWebhookPath(id)}` },
      mode: 'webhook',
      health: { state: 'waiting', lastUpdateAt: null, lastError: null, lastErrorAt: null },
      createdAt: created,
      ...fields,
    };
  }
}
