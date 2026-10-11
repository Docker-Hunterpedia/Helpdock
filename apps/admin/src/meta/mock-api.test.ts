import { describe, expect, it } from 'vitest';
import {
  MOCK_INSTAGRAM_ACCOUNT,
  MOCK_INSTAGRAM_TOKEN,
  MOCK_MESSENGER_ACCOUNT,
  MOCK_MESSENGER_PAGE_ID,
  MOCK_MESSENGER_TOKEN,
  MOCK_NEW_INSTAGRAM_ID,
  MOCK_NEW_MESSENGER_PAGE_ID,
  MOCK_NEW_WHATSAPP_PHONE_ID,
  MOCK_OTHER_ACCOUNT_TOKEN,
  MOCK_REFUSED_TOKEN,
  MOCK_WHATSAPP_ACCOUNT,
  MOCK_WHATSAPP_TEST_ACCOUNT,
  MOCK_WHATSAPP_TOKEN,
  MockMetaApi,
} from './mock-api.js';

/**
 * The fixture refuses what the api refuses, closely enough for the screens'
 * error lines to be exercised; the real rules are the api's and are tested in
 * `meta-accounts.integration.test.ts`.
 */

const SUPPORT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

const connect = {
  departmentId: SUPPORT,
  humanAgentEnabled: false,
} as const;

describe('MockMetaApi', () => {
  it('lists the artboard’s four accounts with their health', async () => {
    const { accounts } = await new MockMetaApi().accounts('brand');

    expect(accounts.map((account) => [account.platform, account.health])).toEqual([
      ['instagram', 'failing'],
      ['messenger', 'healthy'],
      ['whatsapp', 'healthy'],
      ['whatsapp', 'waiting'],
    ]);
    expect(accounts.every((account) => account.tokenSet && account.tokenHint.length === 4)).toBe(
      true,
    );
  });

  it('tests a typed token per platform and quotes Meta when it is refused', async () => {
    const api = new MockMetaApi();

    expect(
      await api.testToken('brand', {
        platform: 'whatsapp',
        externalId: MOCK_NEW_WHATSAPP_PHONE_ID,
        accessToken: MOCK_WHATSAPP_TOKEN,
      }),
    ).toMatchObject({ ok: true, name: 'Helpdock 8204' });
    expect(
      await api.testToken('brand', {
        platform: 'instagram',
        externalId: MOCK_NEW_INSTAGRAM_ID,
        accessToken: MOCK_INSTAGRAM_TOKEN,
      }),
    ).toMatchObject({ ok: true, username: 'helpdock_0111' });
    expect(
      await api.testToken('brand', {
        platform: 'messenger',
        externalId: MOCK_NEW_MESSENGER_PAGE_ID,
        accessToken: MOCK_REFUSED_TOKEN,
      }),
    ).toMatchObject({ ok: false, kind: 'token', detail: expect.stringContaining('(190)') });
    expect(
      await api.testToken('brand', {
        platform: 'instagram',
        externalId: MOCK_NEW_INSTAGRAM_ID,
        accessToken: MOCK_WHATSAPP_TOKEN,
      }),
    ).toMatchObject({ ok: false });
  });

  it('refuses a token Meta does not know, another platform’s token and an id already connected', async () => {
    const api = new MockMetaApi();
    const messenger = {
      ...connect,
      platform: 'messenger',
      externalId: MOCK_NEW_MESSENGER_PAGE_ID,
    } as const;

    await expect(
      api.createAccount('brand', { ...messenger, accessToken: MOCK_REFUSED_TOKEN }),
    ).rejects.toMatchObject({ reason: 'token-invalid' });
    await expect(
      api.createAccount('brand', { ...messenger, accessToken: MOCK_INSTAGRAM_TOKEN }),
    ).rejects.toMatchObject({ reason: 'platform-mismatch' });
    await expect(
      api.createAccount('brand', {
        ...messenger,
        externalId: MOCK_MESSENGER_PAGE_ID,
        accessToken: MOCK_MESSENGER_TOKEN,
      }),
    ).rejects.toMatchObject({ reason: 'account-taken' });
    await expect(
      api.createAccount('brand', {
        ...messenger,
        departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000ff',
        accessToken: MOCK_MESSENGER_TOKEN,
      }),
    ).rejects.toMatchObject({ reason: 'department-not-found' });
  });

  it('connects an account, subscribed, named by Meta and showing only its token’s last four', async () => {
    const api = new MockMetaApi();

    const created = await api.createAccount('brand', {
      ...connect,
      platform: 'instagram',
      externalId: MOCK_NEW_INSTAGRAM_ID,
      accessToken: MOCK_INSTAGRAM_TOKEN,
      humanAgentEnabled: true,
    });

    expect(created).toMatchObject({
      platform: 'instagram',
      username: 'helpdock_0111',
      tokenHint: MOCK_INSTAGRAM_TOKEN.slice(-4),
      tokenKind: 'instagram_user',
      humanAgentEnabled: true,
      health: 'waiting',
    });
    expect(created.subscribedAt).not.toBeNull();
    expect(JSON.stringify(created)).not.toContain(MOCK_INSTAGRAM_TOKEN);
    expect((await api.accounts('brand')).accounts).toHaveLength(5);
  });

  it('keeps the Human Agent switch off for a WhatsApp number', async () => {
    const api = new MockMetaApi();

    const saved = await api.updateAccount('brand', MOCK_WHATSAPP_ACCOUNT, {
      displayName: 'Helpdock Support',
      departmentId: SUPPORT,
      humanAgentEnabled: true,
    });

    expect(saved.humanAgentEnabled).toBe(false);
  });

  it('keeps a replacement token to the same account, and a good one revives an expired account', async () => {
    const api = new MockMetaApi();
    const save = (accessToken: string) =>
      api.updateAccount('brand', MOCK_INSTAGRAM_ACCOUNT, {
        displayName: 'Helpdock',
        departmentId: SUPPORT,
        humanAgentEnabled: false,
        accessToken,
      });

    await expect(save(MOCK_REFUSED_TOKEN)).rejects.toMatchObject({ reason: 'token-invalid' });
    await expect(save(MOCK_OTHER_ACCOUNT_TOKEN)).rejects.toMatchObject({
      reason: 'token-invalid',
    });
    await expect(save(`${MOCK_INSTAGRAM_TOKEN}OTHER`)).rejects.toMatchObject({
      reason: 'token-other-account',
    });

    const revived = await save(MOCK_INSTAGRAM_TOKEN);
    expect(revived).toMatchObject({
      status: 'connected',
      lastError: null,
      tokenHint: MOCK_INSTAGRAM_TOKEN.slice(-4),
      tokenUpdatedByName: 'Lina Haddad',
    });
    expect(revived.tokenExpiresAt).not.toBeNull();
  });

  it('subscribes a healthy account again and cannot subscribe one whose token is dead', async () => {
    const api = new MockMetaApi();

    expect(await api.subscribe('brand', MOCK_MESSENGER_ACCOUNT)).toMatchObject({ ok: true });
    expect(await api.subscribe('brand', MOCK_INSTAGRAM_ACCOUNT)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('(190)'),
    });
  });

  it('answers the status panel from the row, with Meta unreachable for a dead token', async () => {
    const api = new MockMetaApi();

    const healthy = await api.status('brand', MOCK_WHATSAPP_ACCOUNT);
    expect(healthy).toMatchObject({ tokenValid: true, liveError: null });
    expect(healthy.activity.openTickets).toBe(14);
    expect(await api.status('brand', MOCK_WHATSAPP_TEST_ACCOUNT)).toMatchObject({
      activity: { lastReplyAt: null, openTickets: 0 },
    });

    expect(await api.status('brand', MOCK_INSTAGRAM_ACCOUNT)).toMatchObject({
      status: 'token_expired',
      tokenValid: false,
      subscribedApps: null,
    });
  });

  it('tests a stored connection, answering the refusal rather than throwing it', async () => {
    const api = new MockMetaApi();

    expect(await api.testAccount('brand', MOCK_WHATSAPP_ACCOUNT)).toMatchObject({
      ok: true,
      name: 'Helpdock Support',
    });
    expect(await api.testAccount('brand', MOCK_INSTAGRAM_ACCOUNT)).toMatchObject({
      ok: false,
      kind: 'token',
    });
  });

  it('makes a new verify token and keeps only its last four characters', async () => {
    const api = new MockMetaApi();
    const before = await api.app();

    const { verifyToken } = await api.rotateVerifyToken();

    const after = await api.app();
    expect(before.verifyTokenHint).toBe('e2f7');
    expect(after.verifyTokenHint).toBe(verifyToken.slice(-4));
    expect(JSON.stringify(after)).not.toContain(verifyToken);
    expect(after.callbackUrl).toBe('https://support.helpdock.io/api/meta/webhook');
  });

  it('forgets a deleted account', async () => {
    const api = new MockMetaApi();

    await api.deleteAccount('brand', MOCK_INSTAGRAM_ACCOUNT);

    await expect(api.account('brand', MOCK_INSTAGRAM_ACCOUNT)).rejects.toThrow();
    expect((await api.accounts('brand')).accounts).toHaveLength(3);
  });
});
