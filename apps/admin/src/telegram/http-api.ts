import {
  type TelegramBot,
  type TelegramBotCreateRequest,
  type TelegramBotList,
  type TelegramBotStatus,
  type TelegramBotUpdateRequest,
  type TelegramTestResult,
  type TelegramTicketContextResponse,
  type TelegramWebhookResult,
  telegramBotListSchema,
  telegramBotSchema,
  telegramBotStatusSchema,
  telegramTestResultSchema,
  telegramTicketContextResponseSchema,
  telegramWebhookResultSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { TelegramApi } from './api.js';

/**
 * The real Telegram service. It shares the app's {@link HttpTransport}, so the
 * access token and its refresh are the ones every other screen uses, and parses
 * every answer through the schema the api declared it with.
 */
export class HttpTelegramApi implements TelegramApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async bots(brandId: string): Promise<TelegramBotList> {
    return telegramBotListSchema.parse(await this.#transport.request('GET', this.#bots(brandId)));
  }

  async bot(brandId: string, botId: string): Promise<TelegramBot> {
    return telegramBotSchema.parse(await this.#transport.request('GET', this.#bot(brandId, botId)));
  }

  async createBot(brandId: string, request: TelegramBotCreateRequest): Promise<TelegramBot> {
    return telegramBotSchema.parse(
      await this.#transport.request('POST', this.#bots(brandId), request),
    );
  }

  async updateBot(
    brandId: string,
    botId: string,
    request: TelegramBotUpdateRequest,
  ): Promise<TelegramBot> {
    return telegramBotSchema.parse(
      await this.#transport.request('PUT', this.#bot(brandId, botId), request),
    );
  }

  async deleteBot(brandId: string, botId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#bot(brandId, botId));
  }

  async testToken(brandId: string, token: string): Promise<TelegramTestResult> {
    return telegramTestResultSchema.parse(
      await this.#transport.request('POST', `${this.#bots(brandId)}/test`, { token }),
    );
  }

  async testBot(brandId: string, botId: string): Promise<TelegramTestResult> {
    return telegramTestResultSchema.parse(
      await this.#transport.request('POST', `${this.#bot(brandId, botId)}/test`),
    );
  }

  async setWebhook(brandId: string, botId: string): Promise<TelegramWebhookResult> {
    return telegramWebhookResultSchema.parse(
      await this.#transport.request('POST', `${this.#bot(brandId, botId)}/webhook`),
    );
  }

  async status(brandId: string, botId: string): Promise<TelegramBotStatus> {
    return telegramBotStatusSchema.parse(
      await this.#transport.request('GET', `${this.#bot(brandId, botId)}/status`),
    );
  }

  async ticketContext(brandId: string, ticketId: string): Promise<TelegramTicketContextResponse> {
    return telegramTicketContextResponseSchema.parse(
      await this.#transport.request('GET', `${this.#ticket(brandId, ticketId)}/telegram`),
    );
  }

  async retryDelivery(brandId: string, ticketId: string, deliveryId: string): Promise<void> {
    await this.#transport.request(
      'POST',
      `${this.#ticket(brandId, ticketId)}/telegram/deliveries/${encodeURIComponent(deliveryId)}/retry`,
    );
  }

  #bots(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/telegram/bots`;
  }

  #bot(brandId: string, botId: string): string {
    return `${this.#bots(brandId)}/${encodeURIComponent(botId)}`;
  }

  #ticket(brandId: string, ticketId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/tickets/${encodeURIComponent(ticketId)}`;
  }
}
