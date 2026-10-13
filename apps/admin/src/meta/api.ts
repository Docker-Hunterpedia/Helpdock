import type {
  MetaAccount,
  MetaAccountCreateRequest,
  MetaAccountList,
  MetaAccountStatusResponse,
  MetaAccountUpdateRequest,
  MetaApp,
  MetaRefusal,
  MetaRefusalDetails,
  MetaSubscribeResult,
  MetaTestResult,
  MetaTicketContextResponse,
  MetaTokenTestRequest,
  MetaVerifyTokenReveal,
} from '@helpdock/schemas';

/**
 * Everything Channels › Meta needs (M10-07): the install's Meta app and a
 * brand's WhatsApp numbers, Facebook Pages and Instagram accounts.
 * `MockMetaApi` is the fixture the unit tests and the mock Playwright projects
 * run against; `HttpMetaApi` is the real service. The same shape as
 * `TelegramApi`: one interface, two adapters, and refusals that cross as a code
 * the screen picks a sentence for.
 *
 * The ticket view's half (M10-08, `Admin/Ticket-Meta`) is `ticketContext` and
 * `retryDelivery`: who a WhatsApp, Messenger or Instagram ticket is with, the
 * reply window for a person writing now, and what happened to each reply.
 */
export interface MetaApi {
  /** The App card, for install admins: the callback URL and what the settings hold. */
  app(): Promise<MetaApp>;
  /** Makes a new verify token and answers it once. */
  rotateVerifyToken(): Promise<MetaVerifyTokenReveal>;

  accounts(brandId: string): Promise<MetaAccountList>;
  account(brandId: string, accountId: string): Promise<MetaAccount>;
  createAccount(brandId: string, request: MetaAccountCreateRequest): Promise<MetaAccount>;
  updateAccount(
    brandId: string,
    accountId: string,
    request: MetaAccountUpdateRequest,
  ): Promise<MetaAccount>;
  deleteAccount(brandId: string, accountId: string): Promise<void>;
  /** "Test" in the Connect dialog: a typed token, before anything is stored. */
  testToken(brandId: string, request: MetaTokenTestRequest): Promise<MetaTestResult>;
  /** "Test connection": the stored token. Answers a refusal rather than throwing it. */
  testAccount(brandId: string, accountId: string): Promise<MetaTestResult>;
  /** "Subscribe now": the Meta app to the account's webhook fields. */
  subscribe(brandId: string, accountId: string): Promise<MetaSubscribeResult>;
  status(brandId: string, accountId: string): Promise<MetaAccountStatusResponse>;

  /**
   * M10-08: the conversation behind a Meta ticket, its reply window, and the
   * deliveries of its replies. `context` is null for a ticket that is not on a
   * Meta channel or has no conversation.
   */
  ticketContext(brandId: string, ticketId: string): Promise<MetaTicketContextResponse>;
  /**
   * M10-08: puts a `failed` delivery back. A `refused` one throws
   * `MetaError('reply-window-closed')`: the customer has to write first.
   */
  retryDelivery(brandId: string, ticketId: string, deliveryId: string): Promise<void>;
}

export const metaKeys = {
  app: () => ['meta', 'app'] as const,
  accounts: (brandId: string) => ['meta', brandId, 'accounts'] as const,
  account: (brandId: string, accountId: string) =>
    ['meta', brandId, 'accounts', accountId] as const,
  status: (brandId: string, accountId: string) =>
    ['meta', brandId, 'accounts', accountId, 'status'] as const,
  ticket: (brandId: string, ticketId: string) => ['meta', brandId, 'tickets', ticketId] as const,
};

export class MetaError extends Error {
  readonly reason: MetaRefusal;
  /** What a `reply-window-closed` refusal adds: the platform and when the window closed. */
  readonly details: MetaRefusalDetails | undefined;

  constructor(reason: MetaRefusal, details?: MetaRefusalDetails) {
    super(`meta: ${reason}`);
    this.name = 'MetaError';
    this.reason = reason;
    this.details = details;
  }
}

export const isMetaError = (error: unknown): error is MetaError => error instanceof MetaError;
