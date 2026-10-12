import { classifyGraphError, type GraphClient, graphRefreshToken } from '@helpdock/channels';
import { createKeyring, decryptSecret, encryptSecret } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INSTAGRAM_REFRESH_AFTER_MS,
  instagramRefreshDue,
  refreshInstagramToken,
  type TokenRefreshAccount,
  type TokenRefreshDeps,
} from './meta-token-refresh.js';

// The writes run in a transaction of their own; the repository is a double, so
// the transaction can be a placeholder. The real thing is in the integration suite.
vi.mock('../tenant/system-job.js', () => ({
  withSystemJob: async (
    _db: unknown,
    _brandId: string,
    _principal: string,
    fn: (tx: object) => Promise<unknown>,
  ) => fn({}),
}));

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });
const OLD_TOKEN = 'IGAAold-token-0123456789abcdef';
const NEW_TOKEN = 'IGAAnew-token-0123456789abcdef';
const NOW = new Date('2026-10-11T09:20:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const ciphertext = encryptSecret(OLD_TOKEN, keyring);

const account = (overrides: Partial<TokenRefreshAccount> = {}): TokenRefreshAccount => ({
  id: '01924f00-0000-7000-8000-0000000000ac',
  brandId: '01924f00-0000-7000-8000-0000000000aa',
  platform: 'instagram',
  accessToken: ciphertext,
  tokenExpiresAt: new Date(NOW.getTime() + 52 * DAY),
  tokenRefreshedAt: new Date(NOW.getTime() - 8 * DAY),
  tokenUpdatedAt: new Date(NOW.getTime() - 40 * DAY),
  ...overrides,
});

describe('instagramRefreshDue', () => {
  const dueAt = (age: number, over: Partial<TokenRefreshAccount> = {}) =>
    instagramRefreshDue(account({ tokenRefreshedAt: new Date(NOW.getTime() - age), ...over }), NOW);

  it('is due once the last renewal is more than a week old, and not before', () => {
    expect(dueAt(INSTAGRAM_REFRESH_AFTER_MS)).toBe(false);
    expect(dueAt(INSTAGRAM_REFRESH_AFTER_MS + 1)).toBe(true);
    expect(dueAt(8 * DAY)).toBe(true);
    expect(dueAt(1 * DAY)).toBe(false);
  });

  it('counts from when the token was pasted if it has never been renewed', () => {
    const fresh = account({
      tokenRefreshedAt: null,
      tokenUpdatedAt: new Date(NOW.getTime() - 2 * DAY),
    });
    const old = account({
      tokenRefreshedAt: null,
      tokenUpdatedAt: new Date(NOW.getTime() - 20 * DAY),
    });

    expect(instagramRefreshDue(fresh, NOW)).toBe(false);
    expect(instagramRefreshDue(old, NOW)).toBe(true);
  });

  it('does not ask about the row’s expiry, which Meta may know better than the row', () => {
    expect(dueAt(8 * DAY, { tokenExpiresAt: null })).toBe(true);
    expect(dueAt(8 * DAY, { tokenExpiresAt: new Date(NOW.getTime() - DAY) })).toBe(true);
  });

  it('is never due for WhatsApp or Messenger, whose tokens do not expire', () => {
    expect(dueAt(90 * DAY, { platform: 'whatsapp' })).toBe(false);
    expect(dueAt(90 * DAY, { platform: 'messenger' })).toBe(false);
  });
});

describe('refreshInstagramToken', () => {
  const get = vi.fn<GraphClient['get']>();
  const repository = {
    account: vi.fn(),
    update: vi.fn(),
    markError: vi.fn(),
  };
  const deps = (): TokenRefreshDeps => ({
    db: {} as Db,
    repository: repository as unknown as TokenRefreshDeps['repository'],
    keyring,
    graph: { get } as unknown as GraphClient,
    now: () => NOW,
  });

  beforeEach(() => {
    get.mockReset();
    repository.account.mockReset().mockResolvedValue({ accessToken: ciphertext });
    repository.update.mockReset().mockResolvedValue(undefined);
    repository.markError.mockReset().mockResolvedValue(undefined);
  });

  it('stores the renewed token encrypted, with its new expiry and the moment of renewal', async () => {
    get.mockResolvedValue(graphRefreshToken({ accessToken: NEW_TOKEN }));
    const row = account();

    const result = await refreshInstagramToken(deps(), row);

    expect(result).toEqual({ outcome: 'refreshed', expiresAt: new Date(NOW.getTime() + 60 * DAY) });
    expect(repository.update).toHaveBeenCalledExactlyOnceWith({}, row.id, {
      accessToken: expect.any(String),
      tokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
      tokenRefreshedAt: NOW,
    });
    const [, , values] = repository.update.mock.calls[0] ?? [];
    const stored = (values as { accessToken: string }).accessToken;
    expect(stored).not.toContain(NEW_TOKEN);
    expect(decryptSecret(stored, keyring)).toBe(NEW_TOKEN);
  });

  it('asks the Instagram root for a renewal of the stored token', async () => {
    get.mockResolvedValue(graphRefreshToken({ accessToken: NEW_TOKEN }));

    await refreshInstagramToken(deps(), account());

    expect(get).toHaveBeenCalledExactlyOnceWith('/refresh_access_token', {
      token: OLD_TOKEN,
      api: 'instagram',
      query: { grant_type: 'ig_refresh_token' },
    });
  });

  it('asks nothing of Meta and writes nothing when the token is not due', async () => {
    const fresh = account({ tokenRefreshedAt: new Date(NOW.getTime() - 2 * DAY) });

    expect(await refreshInstagramToken(deps(), fresh)).toEqual({ outcome: 'not-due' });
    expect(await refreshInstagramToken(deps(), account({ platform: 'messenger' }))).toEqual({
      outcome: 'not-due',
    });
    expect(get).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('records a refusal as the account’s last error, without the token, and keeps the token', async () => {
    get.mockRejectedValue(
      classifyGraphError(
        400,
        {
          error: {
            code: 100,
            message: 'Invalid parameter',
            error_data: { details: `The token ${OLD_TOKEN} cannot be refreshed` },
          },
        },
        OLD_TOKEN,
      ),
    );

    const result = await refreshInstagramToken(deps(), account());

    expect(result).toEqual({ outcome: 'refused' });
    expect(repository.markError).toHaveBeenCalledExactlyOnceWith(
      {},
      expect.any(String),
      'Instagram would not renew the token: 100: The token <token> cannot be refreshed',
      NOW,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('also marks the account token_expired once the row’s expiry has passed', async () => {
    get.mockRejectedValue(
      classifyGraphError(400, { error: { code: 100, message: 'Cannot be refreshed' } }, OLD_TOKEN),
    );
    const row = account({ tokenExpiresAt: new Date(NOW.getTime() - DAY) });

    await refreshInstagramToken(deps(), row);

    expect(repository.update).toHaveBeenCalledExactlyOnceWith({}, row.id, {
      status: 'token_expired',
    });
  });

  it('marks the account token_expired when Meta itself calls the token dead', async () => {
    get.mockRejectedValue(
      classifyGraphError(
        400,
        { error: { code: 190, message: 'Cannot refresh an expired token' } },
        OLD_TOKEN,
      ),
    );

    await refreshInstagramToken(deps(), account({ tokenExpiresAt: null }));

    expect(repository.update).toHaveBeenCalledExactlyOnceWith({}, expect.any(String), {
      status: 'token_expired',
    });
  });

  it('treats an answer it cannot read as a refusal', async () => {
    get.mockResolvedValue({ unexpected: true });

    expect(await refreshInstagramToken(deps(), account())).toEqual({ outcome: 'refused' });
    expect(repository.markError).toHaveBeenCalledOnce();
  });

  it.each([
    ['Graph down', 503, {}],
    ['a rate limit', 429, { error: { code: 4, message: 'Too many calls' } }],
  ])('throws for %s, because the token is not at fault', async (_name, status, body) => {
    get.mockRejectedValue(classifyGraphError(status, body, OLD_TOKEN));

    await expect(refreshInstagramToken(deps(), account())).rejects.toMatchObject({
      name: 'GraphApiFailure',
    });
    expect(repository.markError).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('does not store what Meta said about an old token over one an operator pasted meanwhile', async () => {
    get.mockResolvedValue(graphRefreshToken({ accessToken: NEW_TOKEN }));
    repository.account.mockResolvedValue({
      accessToken: encryptSecret('pasted-by-an-operator-1', keyring),
    });

    expect(await refreshInstagramToken(deps(), account())).toEqual({ outcome: 'not-due' });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('does not record a refusal against a token that has been replaced', async () => {
    get.mockRejectedValue(
      classifyGraphError(400, { error: { code: 100, message: 'No' } }, OLD_TOKEN),
    );
    repository.account.mockResolvedValue(undefined);

    await refreshInstagramToken(deps(), account());

    expect(repository.markError).not.toHaveBeenCalled();
  });
});
