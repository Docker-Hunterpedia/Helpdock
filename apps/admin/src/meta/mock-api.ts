import {
  META_SUBSCRIBED_FIELDS,
  META_TOKEN_HINT_LENGTH,
  META_TOKEN_KIND,
  type MetaAccount,
  type MetaAccountCreateRequest,
  type MetaAccountList,
  type MetaAccountStatusResponse,
  type MetaAccountUpdateRequest,
  type MetaApp,
  type MetaDeliveryView,
  type MetaPlatform,
  type MetaSubscribeResult,
  type MetaTestResult,
  type MetaTicketContext,
  type MetaTicketContextResponse,
  type MetaTokenTestRequest,
  type MetaUnsent,
  type MetaVerifyTokenReveal,
  metaAccountHealth,
  metaWebhookPath,
} from '@helpdock/schemas';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import { metaDeliverySeed, metaUnsentSeed } from '../tickets/mock-meta-seed.js';
import { type MetaApi, MetaError } from './api.js';
import {
  MOCK_META_CONVERSATIONS,
  MOCK_TICKET_INSTAGRAM,
  MOCK_TICKET_MESSENGER,
  MOCK_TICKET_WHATSAPP,
  mockAnchorAt,
  mockReplyWindow,
} from './mock-conversations.js';

/**
 * The fixture behind Channels › Meta in the unit tests and the mock Playwright
 * projects: the four accounts of the `Admin/Channels-Meta` artboard — two
 * WhatsApp numbers, a Messenger Page and an Instagram account whose token Meta
 * has invalidated — and the install's Meta app.
 *
 * | Token typed | Test answers |
 * |---|---|
 * | `EAAG…` for WhatsApp and Messenger, `IGAA…` for Instagram | the token works; the account is named after its id |
 * | `MOCK_REFUSED_TOKEN` | Meta's 190 |
 * | a token that contains `OTHER` | works for a new account; a *replacement* is refused as another account's |
 * | the other platform's prefix | refused by Test; `platform-mismatch` on Connect |
 * | anything else that looks like a token | Meta's 190 |
 */

const [SUPPORT, , ONBOARDING] = MOCK_DEPARTMENTS;
const ADMIN_NAME = 'Lina Haddad';
const APP_URL = 'https://support.helpdock.io';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The accounts of the artboard. */
export const MOCK_WHATSAPP_ACCOUNT = '0192c3f0-1a2b-7c3d-8e4f-0000000008a1';
export const MOCK_WHATSAPP_TEST_ACCOUNT = '0192c3f0-1a2b-7c3d-8e4f-0000000008a2';
export const MOCK_MESSENGER_ACCOUNT = '0192c3f0-1a2b-7c3d-8e4f-0000000008a3';
export const MOCK_INSTAGRAM_ACCOUNT = '0192c3f0-1a2b-7c3d-8e4f-0000000008a4';

/** The ids Meta issued to the artboard's accounts, which Connect refuses as taken. */
export const MOCK_WHATSAPP_PHONE_ID = '109384715520331';
export const MOCK_MESSENGER_PAGE_ID = '104857223916604';
export const MOCK_INSTAGRAM_ID = '17841405822304914';

/** An id of each platform that no account has: what the Connect dialog adds. */
export const MOCK_NEW_WHATSAPP_PHONE_ID = '109384715588204';
export const MOCK_NEW_MESSENGER_PAGE_ID = '104857223900111';
export const MOCK_NEW_INSTAGRAM_ID = '17841405822300111';

/** What "Test" accepts, per platform. */
export const MOCK_WHATSAPP_TOKEN = 'EAAGsystemUserTokenForTheFixtureAbcdefgh';
export const MOCK_MESSENGER_TOKEN = 'EAAGpageAccessTokenForTheFixtureAbcdefgh';
export const MOCK_INSTAGRAM_TOKEN = 'IGAAinstagramUserTokenForTheFixtureAbcdefgh';
/** What it refuses with Meta's 190. */
export const MOCK_REFUSED_TOKEN = 'EAAGrevokedTokenForTheFixtureAbcdefghijk';
/** A good token of another account: Test passes, a replacement for a different account does not. */
export const MOCK_OTHER_ACCOUNT_TOKEN = 'EAAGtokenOfAnotherAccountOTHERAbcdefgh';

const REFUSED_DETAIL = 'Invalid OAuth access token - Cannot parse access token (190)';
const TOKEN_PREFIX: Readonly<Record<MetaPlatform, string>> = {
  whatsapp: 'EAAG',
  messenger: 'EAAG',
  instagram: 'IGAA',
};
const KNOWN_NAMES: Readonly<Record<string, { name: string; username?: string }>> = {
  [MOCK_WHATSAPP_PHONE_ID]: { name: 'Helpdock Support' },
  [MOCK_MESSENGER_PAGE_ID]: { name: 'Helpdock' },
  [MOCK_INSTAGRAM_ID]: { name: 'Helpdock', username: 'helpdock' },
};

const minutesAgo = (now: number, minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const departmentName = (id: string): string =>
  MOCK_DEPARTMENTS.find((department) => department.id === id)?.name ?? '';

/** Whether a token of this shape belongs to this platform, in the fixture's convention. */
const tokenFits = (platform: MetaPlatform, token: string): boolean =>
  token.startsWith(TOKEN_PREFIX[platform]);

type Verdict = 'good' | 'refused' | 'other-platform';

const judge = (platform: MetaPlatform, token: string): Verdict => {
  if (token === MOCK_REFUSED_TOKEN) {
    return 'refused';
  }
  if (tokenFits(platform, token)) {
    return 'good';
  }
  // A token of the other Graph root is a real one, for another product.
  const other = Object.values(TOKEN_PREFIX).some((prefix) => token.startsWith(prefix));
  return other ? 'other-platform' : 'refused';
};

export class MockMetaApi implements MetaApi {
  readonly #accounts = new Map<string, MetaAccount>();
  readonly #now: () => number;
  /** When the fixture was built: the instant the Meta tickets' last customer messages are measured back from. */
  readonly #epoch: number;
  /** M10-08: each reply's delivery on the three Meta tickets, which Retry changes. */
  readonly #deliveries: Record<string, MetaDeliveryView[]>;
  /** M10-08: the messages the customer unsent, by ticket. */
  readonly #unsent: Record<string, MetaUnsent[]>;
  #app: MetaApp;
  #sequence = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    const at = now();
    this.#epoch = at;
    this.#deliveries = metaDeliverySeed(at);
    this.#unsent = metaUnsentSeed(at);
    this.#app = {
      appIdSet: true,
      appId: '1290457718832406',
      appSecretSet: true,
      instagramAppSecretSet: true,
      graphVersion: 'v25.0',
      callbackUrl: `${APP_URL}${metaWebhookPath()}`,
      verifyTokenHint: 'e2f7',
      secretsLockedByEnv: ['meta.appSecret'],
    };
    const support = SUPPORT?.id ?? '';
    const sales = ONBOARDING?.id ?? '';
    this.#accounts.set(
      MOCK_WHATSAPP_ACCOUNT,
      this.#row(MOCK_WHATSAPP_ACCOUNT, {
        platform: 'whatsapp',
        externalId: MOCK_WHATSAPP_PHONE_ID,
        wabaId: '105027842193350',
        displayPhone: '+1 555 0142',
        displayName: 'Helpdock Support',
        departmentId: support,
        tokenHint: '3fa9',
        subscribedAt: minutesAgo(at, 5 * 24 * 60),
        lastEventAt: minutesAgo(at, 2),
      }),
    );
    this.#accounts.set(
      MOCK_WHATSAPP_TEST_ACCOUNT,
      this.#row(MOCK_WHATSAPP_TEST_ACCOUNT, {
        platform: 'whatsapp',
        externalId: '106540352242922',
        wabaId: '105027842193350',
        displayPhone: '+1 555 0100',
        displayName: 'Meta test number',
        departmentId: support,
        tokenHint: '3fa9',
        subscribedAt: minutesAgo(at, 3 * 60),
        lastEventAt: null,
      }),
    );
    this.#accounts.set(
      MOCK_MESSENGER_ACCOUNT,
      this.#row(MOCK_MESSENGER_ACCOUNT, {
        platform: 'messenger',
        externalId: MOCK_MESSENGER_PAGE_ID,
        username: 'Helpdock',
        displayName: 'Helpdock',
        departmentId: support,
        tokenHint: '8KQZ',
        subscribedAt: minutesAgo(at, 90),
        lastEventAt: minutesAgo(at, 24),
      }),
    );
    this.#accounts.set(
      MOCK_INSTAGRAM_ACCOUNT,
      this.#row(MOCK_INSTAGRAM_ACCOUNT, {
        platform: 'instagram',
        externalId: MOCK_INSTAGRAM_ID,
        username: 'helpdock',
        displayName: 'Helpdock',
        departmentId: sales,
        tokenHint: 'Qw7L',
        status: 'token_expired',
        subscribedAt: minutesAgo(at, 5 * 60),
        lastEventAt: minutesAgo(at, 20 * 60),
        lastError:
          'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons. (190)',
        lastErrorAt: minutesAgo(at, 4 * 60),
      }),
    );
  }

  async app(): Promise<MetaApp> {
    await sleep();
    return { ...this.#app, secretsLockedByEnv: [...this.#app.secretsLockedByEnv] };
  }

  async rotateVerifyToken(): Promise<MetaVerifyTokenReveal> {
    await sleep();
    this.#sequence += 1;
    const verifyToken = `hd_mvt_4f9c2a7e1b3d${this.#sequence.toString(16).padStart(4, '0')}`;
    this.#app = { ...this.#app, verifyTokenHint: verifyToken.slice(-META_TOKEN_HINT_LENGTH) };
    return { verifyToken };
  }

  async accounts(_brandId: string): Promise<MetaAccountList> {
    await sleep();
    return {
      accounts: [...this.#accounts.values()].sort(
        (a, b) =>
          a.platform.localeCompare(b.platform) || a.displayName.localeCompare(b.displayName),
      ),
    };
  }

  async account(_brandId: string, accountId: string): Promise<MetaAccount> {
    await sleep();
    return this.#require(accountId);
  }

  async createAccount(_brandId: string, request: MetaAccountCreateRequest): Promise<MetaAccount> {
    await sleep();
    const verdict = judge(request.platform, request.accessToken);
    if (verdict === 'other-platform') {
      throw new MetaError('platform-mismatch');
    }
    if (verdict === 'refused') {
      throw new MetaError('token-invalid');
    }
    if (
      [...this.#accounts.values()].some(
        (account) =>
          account.platform === request.platform && account.externalId === request.externalId,
      )
    ) {
      throw new MetaError('account-taken');
    }
    if (!MOCK_DEPARTMENTS.some((department) => department.id === request.departmentId)) {
      throw new MetaError('department-not-found');
    }
    this.#sequence += 1;
    const id = `0192c3f0-1a2b-7c3d-8e4f-0000000008b${this.#sequence.toString(16)}`;
    const named = this.#identify(request.platform, request.externalId);
    const at = this.#now();
    const account = this.#row(id, {
      platform: request.platform,
      externalId: request.externalId,
      ...(request.platform === 'whatsapp'
        ? { displayPhone: `+1 555 ${request.externalId.slice(-4)}` }
        : {}),
      ...(named.username === undefined ? {} : { username: named.username }),
      displayName: request.displayName ?? named.name,
      departmentId: request.departmentId,
      tokenHint: request.accessToken.slice(-META_TOKEN_HINT_LENGTH),
      humanAgentEnabled: request.platform !== 'whatsapp' && request.humanAgentEnabled,
      subscribedAt: new Date(at).toISOString(),
    });
    this.#accounts.set(id, account);
    return account;
  }

  async updateAccount(
    _brandId: string,
    accountId: string,
    request: MetaAccountUpdateRequest,
  ): Promise<MetaAccount> {
    await sleep();
    const current = this.#require(accountId);
    if (request.accessToken !== undefined) {
      const verdict = judge(current.platform, request.accessToken);
      if (verdict !== 'good') {
        throw new MetaError('token-invalid');
      }
      if (request.accessToken.includes('OTHER')) {
        throw new MetaError('token-other-account');
      }
    }
    const replaced = request.accessToken !== undefined;
    const at = this.#now();
    const lastEventAt = current.lastEventAt === null ? null : new Date(current.lastEventAt);
    const next: MetaAccount = {
      ...current,
      displayName: request.displayName,
      departmentId: request.departmentId,
      departmentName: departmentName(request.departmentId),
      humanAgentEnabled: current.platform !== 'whatsapp' && request.humanAgentEnabled,
      ...(replaced
        ? {
            tokenHint: request.accessToken?.slice(-META_TOKEN_HINT_LENGTH) ?? current.tokenHint,
            tokenUpdatedAt: new Date(at).toISOString(),
            tokenUpdatedByName: ADMIN_NAME,
            tokenExpiresAt:
              current.tokenKind === 'instagram_user'
                ? new Date(at + 60 * DAY_MS).toISOString()
                : null,
            status: 'connected' as const,
            lastError: null,
            lastErrorAt: null,
            health: metaAccountHealth({ status: 'connected', lastEventAt, lastErrorAt: null }),
          }
        : {}),
    };
    this.#accounts.set(accountId, next);
    return next;
  }

  async deleteAccount(_brandId: string, accountId: string): Promise<void> {
    await sleep();
    this.#require(accountId);
    this.#accounts.delete(accountId);
  }

  async testToken(_brandId: string, request: MetaTokenTestRequest): Promise<MetaTestResult> {
    await sleep();
    return this.#test(request.platform, request.externalId, request.accessToken);
  }

  async testAccount(_brandId: string, accountId: string): Promise<MetaTestResult> {
    await sleep();
    const account = this.#require(accountId);
    if (account.status === 'token_expired') {
      return { ok: false, kind: 'token', detail: account.lastError };
    }
    return {
      ok: true,
      platform: account.platform,
      externalId: account.externalId,
      name: account.displayName,
      ...(account.platform === 'instagram' && account.username !== null
        ? { username: account.username }
        : {}),
      ...(account.tokenExpiresAt === null ? {} : { tokenExpiresAt: account.tokenExpiresAt }),
    };
  }

  async subscribe(_brandId: string, accountId: string): Promise<MetaSubscribeResult> {
    await sleep();
    const account = this.#require(accountId);
    if (account.status === 'token_expired') {
      return { ok: false, detail: account.lastError };
    }
    const subscribedAt = new Date(this.#now()).toISOString();
    this.#accounts.set(accountId, {
      ...account,
      subscribedAt,
      subscribedFields: [...META_SUBSCRIBED_FIELDS[account.platform]],
      status: 'connected',
    });
    return {
      ok: true,
      subscribedFields: [...META_SUBSCRIBED_FIELDS[account.platform]],
      subscribedAt,
    };
  }

  async status(_brandId: string, accountId: string): Promise<MetaAccountStatusResponse> {
    await sleep();
    const account = this.#require(accountId);
    const at = this.#now();
    const expired = account.status === 'token_expired';
    const busy = accountId === MOCK_MESSENGER_ACCOUNT || accountId === MOCK_WHATSAPP_ACCOUNT;

    return {
      status: account.status,
      health: account.health,
      lastEventAt: account.lastEventAt,
      lastError: account.lastError,
      lastErrorAt: account.lastErrorAt,
      tokenExpiresAt: account.tokenExpiresAt,
      subscribedFields: account.subscribedFields,
      subscribedAt: account.subscribedAt,
      subscriptionCheckedAt: expired ? account.subscribedAt : minutesAgo(at, 8),
      tokenValid: !expired,
      subscribedApps: expired
        ? null
        : [
            {
              id: '1290457718832406',
              name: 'Helpdock',
              subscribedFields: account.subscribedFields,
            },
          ],
      liveError: expired ? account.lastError : null,
      activity: {
        lastReplyAt: busy ? minutesAgo(at, 1) : null,
        failedSends: accountId === MOCK_MESSENGER_ACCOUNT ? 1 : 0,
        refusedSends: accountId === MOCK_MESSENGER_ACCOUNT ? 2 : 0,
        openTickets: accountId === MOCK_WHATSAPP_ACCOUNT ? 14 : busy ? 9 : 0,
      },
    };
  }

  async ticketContext(_brandId: string, ticketId: string): Promise<MetaTicketContextResponse> {
    await sleep();
    const context = this.#ticketContext(ticketId);
    if (context === null) {
      return { context: null, deliveries: [], unsent: [] };
    }

    return {
      context,
      deliveries: (this.#deliveries[ticketId] ?? []).map((delivery) => ({
        ...delivery,
        leftOut: [...delivery.leftOut],
      })),
      unsent: (this.#unsent[ticketId] ?? []).map((unsent) => ({ ...unsent })),
    };
  }

  async retryDelivery(_brandId: string, ticketId: string, deliveryId: string): Promise<void> {
    await sleep();
    const delivery = this.#deliveries[ticketId]?.find((candidate) => candidate.id === deliveryId);
    const conversation = MOCK_META_CONVERSATIONS[ticketId];
    if (delivery === undefined || conversation === undefined) {
      throw new Error(`no such delivery: ${deliveryId}`);
    }
    if (delivery.status === 'refused') {
      // The customer has to write first (DOMAIN-RULES §2.6): the same refusal
      // a reply written after the window gets.
      const window = mockReplyWindow(conversation, this.#epoch, this.#now());
      throw new MetaError('reply-window-closed', {
        platform: conversation.platform,
        anchorAt: mockAnchorAt(conversation, this.#epoch),
        closedAt: window.state === 'closed' ? window.closedAt : null,
      });
    }
    if (delivery.status !== 'failed') {
      return;
    }
    Object.assign(delivery, {
      status: 'sent',
      partsSent: delivery.partsTotal,
      attempts: 0,
      lastError: null,
      errorCode: null,
      failedAt: null,
      sentAt: new Date(this.#now()).toISOString(),
    } satisfies Partial<MetaDeliveryView>);
  }

  /** Who a fixture ticket is with and its window now, or null for any other ticket. */
  #ticketContext(ticketId: string): MetaTicketContext | null {
    const conversation = MOCK_META_CONVERSATIONS[ticketId];
    if (conversation === undefined) {
      return null;
    }
    const window = mockReplyWindow(conversation, this.#epoch, this.#now());
    switch (ticketId) {
      case MOCK_TICKET_WHATSAPP:
        return {
          account: {
            id: MOCK_WHATSAPP_ACCOUNT,
            platform: 'whatsapp',
            externalId: MOCK_WHATSAPP_PHONE_ID,
            displayName: 'Helpdock Support',
            displayPhone: '+1 555 0142',
          },
          customerId: 'US.13491208655302741918',
          phone: '+44 7700 900123',
          phoneVerified: true,
          profileName: 'Daniel R.',
          window,
        };
      case MOCK_TICKET_MESSENGER:
        return {
          account: {
            id: MOCK_MESSENGER_ACCOUNT,
            platform: 'messenger',
            externalId: MOCK_MESSENGER_PAGE_ID,
            displayName: 'Helpdock',
            username: 'Helpdock',
          },
          customerId: '7120458839201457',
          phoneVerified: false,
          window,
        };
      case MOCK_TICKET_INSTAGRAM:
        return {
          account: {
            id: MOCK_INSTAGRAM_ACCOUNT,
            platform: 'instagram',
            externalId: MOCK_INSTAGRAM_ID,
            displayName: 'Helpdock',
            username: 'helpdock',
          },
          customerId: '6829104477310925',
          phoneVerified: false,
          profileName: 'Sara M.',
          username: 'sara.makes',
          window,
        };
      default:
        return null;
    }
  }

  #require(accountId: string): MetaAccount {
    const account = this.#accounts.get(accountId);
    if (account === undefined) {
      throw new Error(`no such account: ${accountId}`);
    }
    return account;
  }

  #identify(platform: MetaPlatform, externalId: string): { name: string; username?: string } {
    const known = KNOWN_NAMES[externalId];
    if (known !== undefined) {
      return known;
    }
    const tail = externalId.slice(-4);
    return platform === 'instagram'
      ? { name: `Helpdock ${tail}`, username: `helpdock_${tail}` }
      : { name: `Helpdock ${tail}` };
  }

  #test(platform: MetaPlatform, externalId: string, token: string): MetaTestResult {
    if (judge(platform, token) !== 'good') {
      return { ok: false, kind: 'token', detail: REFUSED_DETAIL };
    }
    const named = this.#identify(platform, externalId);
    return {
      ok: true,
      platform,
      externalId,
      name: named.name,
      ...(named.username === undefined ? {} : { username: named.username }),
      ...(platform === 'instagram'
        ? { tokenExpiresAt: new Date(this.#now() + 60 * DAY_MS).toISOString() }
        : {}),
    };
  }

  #row(
    id: string,
    fields: Pick<MetaAccount, 'platform' | 'externalId' | 'displayName' | 'departmentId'> &
      Partial<Omit<MetaAccount, 'health'>>,
  ): MetaAccount {
    const created = '2026-10-02T09:00:00.000Z';
    const status = fields.status ?? 'connected';
    const lastEventAt = fields.lastEventAt ?? null;
    const lastErrorAt = fields.lastErrorAt ?? null;

    return {
      id,
      wabaId: null,
      displayPhone: null,
      username: null,
      departmentName: departmentName(fields.departmentId),
      tokenSet: true,
      tokenHint: '0000',
      tokenKind: META_TOKEN_KIND[fields.platform],
      tokenExpiresAt:
        fields.platform === 'instagram' ? new Date(this.#now() + 52 * DAY_MS).toISOString() : null,
      tokenUpdatedAt: created,
      tokenUpdatedByName: ADMIN_NAME,
      humanAgentEnabled: false,
      subscribedFields: [...META_SUBSCRIBED_FIELDS[fields.platform]],
      subscribedAt: null,
      status,
      lastEventAt,
      lastError: null,
      lastErrorAt,
      createdAt: created,
      ...fields,
      health: metaAccountHealth({
        status,
        lastEventAt: lastEventAt === null ? null : new Date(lastEventAt),
        lastErrorAt: lastErrorAt === null ? null : new Date(lastErrorAt),
      }),
    };
  }
}
