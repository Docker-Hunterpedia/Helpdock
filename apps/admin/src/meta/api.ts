import type {
  MetaAccount,
  MetaAccountCreateRequest,
  MetaAccountList,
  MetaAccountStatusResponse,
  MetaAccountUpdateRequest,
  MetaApp,
  MetaRefusal,
  MetaSubscribeResult,
  MetaTestResult,
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
 * The ticket view's half (the reply window, each reply's delivery and Retry) is
 * M10-08's and joins this interface there.
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
}

export const metaKeys = {
  app: () => ['meta', 'app'] as const,
  accounts: (brandId: string) => ['meta', brandId, 'accounts'] as const,
  account: (brandId: string, accountId: string) =>
    ['meta', brandId, 'accounts', accountId] as const,
  status: (brandId: string, accountId: string) =>
    ['meta', brandId, 'accounts', accountId, 'status'] as const,
};

export class MetaError extends Error {
  readonly reason: MetaRefusal;

  constructor(reason: MetaRefusal) {
    super(`meta: ${reason}`);
    this.name = 'MetaError';
    this.reason = reason;
  }
}

export const isMetaError = (error: unknown): error is MetaError => error instanceof MetaError;
