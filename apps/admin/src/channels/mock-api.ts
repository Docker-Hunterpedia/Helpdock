import type {
  ImapTestRequest,
  ImapTestResult,
  InboundParseSecret,
  InboundParseSettings,
  Mailbox,
  MailboxCreateRequest,
  MailboxList,
  MailboxUpdateRequest,
} from '@helpdock/schemas';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import { type ChannelsApi, ChannelsError } from './api.js';

/**
 * The fixture behind Channels › Mailboxes in the unit tests and the mock
 * Playwright projects: the four mailboxes of the `Admin · email channel`
 * artboard, one in each health state, and a "Test IMAP" that answers the way a
 * server would.
 *
 * | Typed | Test IMAP answers |
 * |---|---|
 * | password `wrong` | the server refused the sign-in |
 * | a host containing `unreachable` | no answer within 15 s |
 * | a folder other than `INBOX` | the folder does not exist |
 * | anything else | connected, 1,284 messages, 3 unread |
 */

const [SUPPORT, BILLING, ONBOARDING] = MOCK_DEPARTMENTS;
const ADMIN_NAME = 'Lina Haddad';

const minutesAgo = (now: number, minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

/** A 1×1 teal pixel: what the proxy hands back in the fixture. */
export const MOCK_REMOTE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

const departmentName = (id: string): string =>
  MOCK_DEPARTMENTS.find((department) => department.id === id)?.name ?? 'Support';

const imap = (
  host: string,
  overrides: Partial<NonNullable<Mailbox['imap']>> = {},
): NonNullable<Mailbox['imap']> => ({
  host,
  port: 993,
  security: 'tls',
  username: 'support@helpdock.io',
  folder: 'INBOX',
  pollIntervalSeconds: 60,
  passwordSet: true,
  passwordUpdatedAt: '2026-09-14T09:00:00.000Z',
  passwordUpdatedByName: ADMIN_NAME,
  ...overrides,
});

const health = (overrides: Partial<Mailbox['health']>): Mailbox['health'] => ({
  state: 'healthy',
  lastPolledAt: null,
  lastSuccessAt: null,
  lastReceivedAt: null,
  lastError: null,
  lastErrorKind: null,
  lastErrorAt: null,
  ...overrides,
});

const seed = (now: number): Mailbox[] => [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e1',
    address: 'billing@helpdock.io',
    displayName: 'Helpdock Billing',
    departmentId: BILLING?.id ?? '',
    departmentName: 'Billing',
    method: 'imap',
    imap: imap('imap.fastmail.com', { username: 'billing@helpdock.io' }),
    inboundProvider: null,
    remoteImages: 'block',
    authFailureIsSpam: true,
    automatedAllowlist: ['alerts@statuspage.io'],
    health: health({
      state: 'failing',
      lastPolledAt: minutesAgo(now, 1),
      lastSuccessAt: minutesAgo(now, 90),
      lastError: 'A1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
      lastErrorKind: 'auth',
      lastErrorAt: minutesAgo(now, 30),
    }),
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e2',
    address: 'hello@helpdock.io',
    displayName: 'Helpdock',
    departmentId: ONBOARDING?.id ?? '',
    departmentName: 'Onboarding',
    method: 'inbound_parse',
    imap: null,
    inboundProvider: 'postmark',
    remoteImages: 'proxy',
    authFailureIsSpam: false,
    automatedAllowlist: [],
    health: health({ lastSuccessAt: minutesAgo(now, 3), lastReceivedAt: minutesAgo(now, 3) }),
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e3',
    address: 'returns@helpdock.io',
    displayName: 'Helpdock Returns',
    departmentId: SUPPORT?.id ?? '',
    departmentName: 'Support',
    method: 'imap',
    imap: imap('mail.helpdock.io', { username: 'returns@helpdock.io' }),
    inboundProvider: null,
    remoteImages: 'block',
    authFailureIsSpam: false,
    automatedAllowlist: [],
    health: health({
      state: 'behind',
      lastPolledAt: minutesAgo(now, 6),
      lastSuccessAt: minutesAgo(now, 6),
    }),
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e4',
    address: 'support@helpdock.io',
    displayName: 'Helpdock Support',
    departmentId: SUPPORT?.id ?? '',
    departmentName: 'Support',
    method: 'imap',
    imap: imap('imap.fastmail.com'),
    inboundProvider: null,
    remoteImages: 'block',
    authFailureIsSpam: false,
    automatedAllowlist: [],
    health: health({ lastPolledAt: minutesAgo(now, 0.2), lastSuccessAt: minutesAgo(now, 0.2) }),
    createdAt: '2026-09-01T09:00:00.000Z',
  },
];

let nextId = 100;

export class MockChannelsApi implements ChannelsApi {
  readonly #now: () => number;
  #mailboxes: Mailbox[];
  #settings: InboundParseSettings;
  #passwords = new Map<string, string>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#mailboxes = seed(now());
    this.#settings = {
      secretSet: true,
      secretUpdatedAt: '2026-09-10T09:00:00.000Z',
      lastRequest: { provider: 'postmark', at: minutesAgo(now(), 3), outcome: 'accepted' },
    };
  }

  async mailboxes(): Promise<MailboxList> {
    await Promise.resolve();
    return {
      mailboxes: [...this.#mailboxes].sort((a, b) => a.address.localeCompare(b.address)),
    };
  }

  async mailbox(_brandId: string, mailboxId: string): Promise<Mailbox> {
    await Promise.resolve();
    const found = this.#mailboxes.find((mailbox) => mailbox.id === mailboxId);
    if (found === undefined) {
      throw new Error('No such mailbox');
    }

    return found;
  }

  async createMailbox(_brandId: string, request: MailboxCreateRequest): Promise<Mailbox> {
    await Promise.resolve();
    this.#refuseTaken(request.address, null);
    nextId += 1;
    const id = `0192c3f0-1a2b-7c3d-8e4f-${String(nextId).padStart(12, '0')}`;
    const mailbox = this.#build(id, request, null);
    if (request.method === 'imap') {
      this.#passwords.set(id, request.imap.password);
    }
    this.#mailboxes.push(mailbox);

    return mailbox;
  }

  async updateMailbox(
    _brandId: string,
    mailboxId: string,
    request: MailboxUpdateRequest,
  ): Promise<Mailbox> {
    await Promise.resolve();
    const current = await this.mailbox('', mailboxId);
    this.#refuseTaken(request.address, mailboxId);
    if (request.method === 'imap' && request.imap.password === undefined && current.imap === null) {
      throw new ChannelsError('password-required');
    }
    if (request.method === 'imap' && request.imap.password !== undefined) {
      this.#passwords.set(mailboxId, request.imap.password);
    }

    const updated = this.#build(mailboxId, request, current);
    this.#mailboxes = this.#mailboxes.map((mailbox) =>
      mailbox.id === mailboxId ? updated : mailbox,
    );

    return updated;
  }

  async deleteMailbox(_brandId: string, mailboxId: string): Promise<void> {
    await Promise.resolve();
    this.#mailboxes = this.#mailboxes.filter((mailbox) => mailbox.id !== mailboxId);
  }

  async testImap(_brandId: string, request: ImapTestRequest): Promise<ImapTestResult> {
    await Promise.resolve();
    const password =
      request.password ??
      (request.mailboxId === undefined
        ? undefined
        : (this.#passwords.get(request.mailboxId) ?? 'stored'));
    const base = { host: request.host, port: request.port };

    if (request.host.includes('unreachable')) {
      return { ok: false, kind: 'timeout', ...base, serverResponse: null };
    }
    if (password === 'wrong') {
      return {
        ok: false,
        kind: 'auth',
        ...base,
        serverResponse: 'A1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
      };
    }
    if (request.folder !== 'INBOX') {
      return { ok: false, kind: 'folder', ...base, serverResponse: 'NO Mailbox does not exist' };
    }

    return { ok: true, ...base, folder: request.folder, messages: 1284, unseen: 3 };
  }

  async inboundParse(): Promise<InboundParseSettings> {
    await Promise.resolve();
    return this.#settings;
  }

  async replaceInboundSecret(): Promise<InboundParseSecret> {
    await Promise.resolve();
    this.#settings = {
      ...this.#settings,
      secretSet: true,
      secretUpdatedAt: new Date(this.#now()).toISOString(),
    };

    return { secret: 'hd_inbound_Qm9vdHN0cmFwLXNlY3JldC1zaG93bi1vbmNl' };
  }

  async remoteImage(): Promise<string> {
    await Promise.resolve();
    return MOCK_REMOTE_IMAGE;
  }

  // ------------------------------------------------------------------

  #refuseTaken(address: string, except: string | null): void {
    const lowered = address.trim().toLowerCase();
    if (this.#mailboxes.some((mailbox) => mailbox.address === lowered && mailbox.id !== except)) {
      throw new ChannelsError('address-taken');
    }
  }

  #build(
    id: string,
    request: MailboxCreateRequest | MailboxUpdateRequest,
    current: Mailbox | null,
  ): Mailbox {
    const now = new Date(this.#now()).toISOString();

    return {
      id,
      address: request.address.trim().toLowerCase(),
      displayName: request.displayName,
      departmentId: request.departmentId,
      departmentName: departmentName(request.departmentId),
      method: request.method,
      imap:
        request.method === 'imap'
          ? {
              host: request.imap.host,
              port: request.imap.port,
              security: request.imap.security,
              username: request.imap.username,
              folder: request.imap.folder,
              pollIntervalSeconds: request.imap.pollIntervalSeconds,
              passwordSet: true,
              passwordUpdatedAt:
                request.imap.password === undefined
                  ? (current?.imap?.passwordUpdatedAt ?? now)
                  : now,
              passwordUpdatedByName: ADMIN_NAME,
            }
          : null,
      inboundProvider: current?.inboundProvider ?? null,
      remoteImages: request.remoteImages,
      authFailureIsSpam: request.authFailureIsSpam,
      automatedAllowlist: [...new Set(request.automatedAllowlist)],
      health:
        current?.health ?? health({ state: request.method === 'imap' ? 'healthy' : 'waiting' }),
      createdAt: current?.createdAt ?? now,
    };
  }
}
