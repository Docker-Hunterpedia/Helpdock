import type {
  TelegramBot,
  TelegramBotCreateRequest,
  TelegramBotList,
  TelegramBotStatus,
  TelegramBotUpdateRequest,
  TelegramRefusal,
  TelegramTestResult,
  TelegramTicketContextResponse,
  TelegramWebhookResult,
} from '@helpdock/schemas';

/**
 * Everything Channels › Telegram and the ticket view's Telegram half need
 * (M6-02, M6-05). `MockTelegramApi` is the fixture the unit tests and the mock
 * Playwright projects run against; `HttpTelegramApi` is the real service. The
 * same shape as `DomainsApi`: one interface, two adapters, and refusals that
 * cross as a code the screen picks a sentence for.
 */
export interface TelegramApi {
  bots(brandId: string): Promise<TelegramBotList>;
  bot(brandId: string, botId: string): Promise<TelegramBot>;
  createBot(brandId: string, request: TelegramBotCreateRequest): Promise<TelegramBot>;
  updateBot(
    brandId: string,
    botId: string,
    request: TelegramBotUpdateRequest,
  ): Promise<TelegramBot>;
  deleteBot(brandId: string, botId: string): Promise<void>;
  /** "Test" in the Add bot dialog: a typed token, before anything is stored. */
  testToken(brandId: string, token: string): Promise<TelegramTestResult>;
  /** "Test connection": the stored token. Answers a refusal rather than throwing it. */
  testBot(brandId: string, botId: string): Promise<TelegramTestResult>;
  setWebhook(brandId: string, botId: string): Promise<TelegramWebhookResult>;
  status(brandId: string, botId: string): Promise<TelegramBotStatus>;

  /** The ticket view: the chat, its bot, and each reply's delivery. */
  ticketContext(brandId: string, ticketId: string): Promise<TelegramTicketContextResponse>;
  retryDelivery(brandId: string, ticketId: string, deliveryId: string): Promise<void>;
}

export const telegramKeys = {
  bots: (brandId: string) => ['telegram', brandId, 'bots'] as const,
  bot: (brandId: string, botId: string) => ['telegram', brandId, 'bots', botId] as const,
  status: (brandId: string, botId: string) =>
    ['telegram', brandId, 'bots', botId, 'status'] as const,
  ticket: (brandId: string, ticketId: string) =>
    ['telegram', brandId, 'tickets', ticketId] as const,
};

export class TelegramError extends Error {
  readonly reason: TelegramRefusal;

  constructor(reason: TelegramRefusal) {
    super(`telegram: ${reason}`);
    this.name = 'TelegramError';
    this.reason = reason;
  }
}

export const isTelegramError = (error: unknown): error is TelegramError =>
  error instanceof TelegramError;
