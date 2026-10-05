import { randomBytes } from 'node:crypto';
import {
  type TelegramApiFailure,
  type TelegramBotIdentity,
  toTelegramFailure,
} from '@helpdock/channels';
import { decryptSecret, encryptSecret, type Keyring } from '@helpdock/config';
import { auditLog, type DbTransaction, type NewTelegramBot } from '@helpdock/db';
import type {
  TelegramBot,
  TelegramBotCreateRequest,
  TelegramBotList,
  TelegramBotStatus,
  TelegramBotUpdateRequest,
  TelegramTestResult,
  TelegramWebhookResult,
} from '@helpdock/schemas';
import { telegramBotHealth } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { apiForBot, type TelegramApiFactory } from './bot-api-factory.js';
import type { BotWithNames, TelegramRepository } from './telegram.repository.js';
import { enqueueTelegramBotChanged } from './telegram-events.js';
import { TelegramFailure } from './telegram-failure.js';
import { type TelegramViewContext, toTelegramBot, webhookUrlFor } from './telegram-view.js';

/**
 * Channels › Telegram (M6-05): the bot list and form, "Test connection", "Set
 * webhook" and the health panel.
 *
 * The rules this module keeps, the same as `MailboxesService`'s:
 *
 * - **A secret goes in and never comes out.** The token and the webhook
 *   secret are encrypted under `APP_MASTER_KEY`; a read says whether a token
 *   is set and which bot it is, nothing more.
 * - **A token is checked before it is stored**, with `getMe`, which also says
 *   which bot it is: the username shown on the list, and the id that keeps one
 *   bot from being connected twice.
 * - **A change to a bot is also a change to its poller** in development:
 *   `telegram_bot.changed` goes to the outbox in the same transaction.
 * - **Every change is audited**, without the token.
 *
 * "Test connection", "Set webhook" and the health panel talk to Telegram from
 * the request, as "Test IMAP" talks to a mail server: they are what the
 * button is for, the answer is shown at once, and none of them reaches a
 * customer.
 */

export type TelegramAuditAction =
  | 'telegram_bot.created'
  | 'telegram_bot.updated'
  | 'telegram_bot.deleted'
  | 'telegram_bot.webhook_set';

export class TelegramBotsService {
  readonly #repository: TelegramRepository;
  readonly #keyring: Keyring;
  readonly #api: TelegramApiFactory;
  readonly #view: TelegramViewContext;
  readonly #now: () => Date;

  constructor(options: {
    readonly repository: TelegramRepository;
    readonly keyring: Keyring;
    readonly api: TelegramApiFactory;
    readonly view: TelegramViewContext;
    readonly now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#keyring = options.keyring;
    this.#api = options.api;
    this.#view = options.view;
    this.#now = options.now ?? (() => new Date());
  }

  async list(tx: DbTransaction): Promise<TelegramBotList> {
    return { bots: (await this.#repository.list(tx)).map((row) => this.#toView(row)) };
  }

  async get(tx: DbTransaction, id: string): Promise<TelegramBot> {
    return this.#toView(await this.#require(tx, id));
  }

  async create(context: TicketingContext, request: TelegramBotCreateRequest): Promise<TelegramBot> {
    const { tx, brandId, actor } = context;
    await this.#requireDepartment(tx, request.departmentId);
    const identity = await this.#identify(request.token);

    const now = this.#now();
    const row = await this.#repository.insert(tx, {
      brandId,
      ...this.#common(request),
      telegramId: identity.id,
      username: identity.username,
      token: encryptSecret(request.token, this.#keyring),
      tokenUpdatedAt: now,
      tokenUpdatedBy: actor.userId,
      // Telegram allows A-Z, a-z, 0-9, `_` and `-`: base64url is exactly that.
      webhookSecret: encryptSecret(randomBytes(32).toString('base64url'), this.#keyring),
    });
    if (row === undefined) {
      throw new TelegramFailure('bot-taken');
    }

    await this.#changed(context, 'telegram_bot.created', row.id, { username: row.username });
    return this.get(tx, row.id);
  }

  async update(
    context: TicketingContext,
    id: string,
    request: TelegramBotUpdateRequest,
  ): Promise<TelegramBot> {
    const { tx, actor } = context;
    const { bot: current } = await this.#require(tx, id);
    await this.#requireDepartment(tx, request.departmentId);

    const values: Partial<NewTelegramBot> = this.#common(request);
    if (request.token !== undefined) {
      const identity = await this.#identify(request.token);
      // A new token for the same bot (BotFather's "revoke"); another bot is a new bot.
      if (identity.id !== current.telegramId) {
        throw new TelegramFailure('token-other-bot');
      }
      Object.assign(values, {
        username: identity.username,
        token: encryptSecret(request.token, this.#keyring),
        tokenUpdatedAt: this.#now(),
        tokenUpdatedBy: actor.userId,
        lastError: null,
        lastErrorAt: null,
      });
    }

    await this.#repository.update(tx, id, values);
    await this.#changed(context, 'telegram_bot.updated', id, {
      tokenReplaced: request.token !== undefined,
    });
    return this.get(tx, id);
  }

  /**
   * The row and its chats go; tickets stay. The webhook is left registered
   * with Telegram, which then gets 401s; deleting the bot in BotFather or
   * pressing "Set webhook" on its replacement is the operator's step.
   */
  async remove(context: TicketingContext, id: string): Promise<void> {
    const removed = await this.#repository.delete(context.tx, id);
    if (removed === undefined) {
      throw new NotFoundException('No such Telegram bot');
    }
    await this.#changed(context, 'telegram_bot.deleted', id, { username: removed.username });
  }

  /** "Test connection": `getMe` with the stored token. Writes nothing. */
  async test(tx: DbTransaction, id: string): Promise<TelegramTestResult> {
    const { bot } = await this.#require(tx, id);
    try {
      const me = await apiForBot(bot, this.#keyring, this.#api).getMe();
      return { ok: true, username: me.username, name: me.name, telegramId: me.id };
    } catch (error) {
      return testFailure(toTelegramFailure(error));
    }
  }

  /**
   * "Test" in the Add bot dialog: `getMe` with a typed token, before anything
   * is stored. Writes nothing and never repeats the token in its answer.
   */
  async testToken(token: string): Promise<TelegramTestResult> {
    try {
      const me = await this.#api(token).getMe();
      return { ok: true, username: me.username, name: me.name, telegramId: me.id };
    } catch (error) {
      return testFailure(toTelegramFailure(error, token));
    }
  }

  /**
   * "Set webhook": registers this install's route for the bot with its
   * secret, and records what was registered. Telegram's refusal is answered,
   * not thrown, so the panel can show it.
   */
  async setWebhook(context: TicketingContext, id: string): Promise<TelegramWebhookResult> {
    const { bot } = await this.#require(context.tx, id);
    const url = webhookUrlFor(this.#view.appUrl, bot.id);
    try {
      await apiForBot(bot, this.#keyring, this.#api).setWebhook(
        url,
        decryptSecret(bot.webhookSecret, this.#keyring),
      );
    } catch (error) {
      return { ok: false, detail: toTelegramFailure(error).detail };
    }

    const setAt = this.#now();
    await this.#repository.update(context.tx, id, { webhookUrl: url, webhookSetAt: setAt });
    await this.#audit(context, 'telegram_bot.webhook_set', id, { url });
    return { ok: true, url, setAt: setAt.toISOString() };
  }

  /** The health panel: the row's facts, and `getWebhookInfo` when Telegram answers. */
  async status(tx: DbTransaction, id: string): Promise<TelegramBotStatus> {
    const { bot } = await this.#require(tx, id);
    const facts = await this.#repository.activity(
      tx,
      id,
      new Date(this.#now().getTime() - FAILED_SENDS_WINDOW_MS),
    );
    const activity = {
      lastReplyAt: facts.lastReplyAt?.toISOString() ?? null,
      failedSends24h: facts.failedSends,
      openTickets: facts.openTickets,
    };
    const health = {
      state: telegramBotHealth(bot),
      lastUpdateAt: bot.lastUpdateAt?.toISOString() ?? null,
      lastError: bot.lastError,
      lastErrorAt: bot.lastErrorAt?.toISOString() ?? null,
    };
    const mode = this.#view.polling ? 'polling' : 'webhook';
    try {
      const info = await apiForBot(bot, this.#keyring, this.#api).getWebhookInfo();
      return {
        health,
        mode,
        webhook: {
          url: info.url,
          pendingUpdateCount: info.pendingUpdateCount,
          lastErrorAt: info.lastErrorAt?.toISOString() ?? null,
          lastErrorMessage: info.lastErrorMessage,
        },
        webhookError: null,
        activity,
      };
    } catch (error) {
      return {
        health,
        mode,
        webhook: null,
        webhookError: toTelegramFailure(error).detail,
        activity,
      };
    }
  }

  // ------------------------------------------------------------------

  /** `getMe` for a typed token: which bot it is, or the refusal the form shows. */
  async #identify(token: string): Promise<TelegramBotIdentity> {
    try {
      return await this.#api(token).getMe();
    } catch (error) {
      const failure = toTelegramFailure(error, token);
      throw new TelegramFailure(
        failure.kind === 'connect' ? 'telegram-unreachable' : 'token-invalid',
      );
    }
  }

  #toView(row: BotWithNames): TelegramBot {
    return toTelegramBot(row, this.#view, decryptSecret(row.bot.token, this.#keyring));
  }

  #common(request: TelegramBotCreateRequest | TelegramBotUpdateRequest) {
    return {
      displayName: request.displayName,
      departmentId: request.departmentId,
      welcomeEn: blankToNull(request.welcomeEn),
      welcomeAr: blankToNull(request.welcomeAr),
      languagePick: request.languagePick,
    };
  }

  async #require(tx: DbTransaction, id: string) {
    const found = await this.#repository.find(tx, id);
    if (found === undefined) {
      throw new NotFoundException('No such Telegram bot');
    }
    return found;
  }

  async #requireDepartment(tx: DbTransaction, departmentId: string): Promise<void> {
    if (!(await this.#repository.departmentExists(tx, departmentId))) {
      throw new TelegramFailure('department-not-found');
    }
  }

  async #changed(
    context: TicketingContext,
    action: TelegramAuditAction,
    botId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.#audit(context, action, botId, meta);
    await enqueueTelegramBotChanged(context.tx, context.brandId, botId);
  }

  async #audit(
    { tx, brandId, actor }: TicketingContext,
    action: TelegramAuditAction,
    botId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action,
      targetType: 'telegram_bot',
      targetId: botId,
      meta,
    });
  }
}

/** "Failed sends, 24 h" on the Activity card. */
const FAILED_SENDS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const testFailure = (failure: TelegramApiFailure): TelegramTestResult => ({
  ok: false,
  kind: failure.kind === 'connect' ? 'connect' : 'token',
  detail: failure.detail,
});

const blankToNull = (value: string | null): string | null =>
  value === null || value === '' ? null : value;
