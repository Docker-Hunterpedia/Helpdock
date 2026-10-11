import { FakeGraph, GraphClient } from '@helpdock/channels';
import { createKeyring, encryptSecret } from '@helpdock/config';
import type { Db, DbTransaction, MetaAccount as MetaAccountRow } from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';
import { metaAccountStatusResponseSchema, metaTestResultSchema } from '@helpdock/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountWithNames, MetaRepository } from './meta.repository.js';
import { MetaAccountsService } from './meta-accounts.service.js';
import { MetaFailure } from './meta-failure.js';

/**
 * What the Connect dialog's "Test", the account page's "Test connection" and
 * the status panel say, against the stand-in for Graph and a repository that
 * holds one row: every refusal of `MetaRefusal` that a Graph read can cause, and
 * that none of them repeats the token. The rest of the service — connecting,
 * saving, disconnecting, auditing — writes rows and is
 * `meta-accounts.integration.test.ts`.
 */

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });
const BRAND = '01924f00-0000-7000-8000-000000000001';
const DEPARTMENT = '01924f00-0000-7000-8000-000000000002';

const NUMBER = '106540352242922';
const OTHER_NUMBER = '106540352242999';
// The business accounts that own them: Meta keeps a number's webhook subscription there.
const WABA = '102290129340398';
const OTHER_WABA = '102290129340111';
const PAGE = '112233445566778';
const INSTAGRAM = '17841400000000000';
const OTHER_INSTAGRAM = '17841400000000999';

const WHATSAPP_TOKEN = 'EAAGwhatsappSystemUserToken0001';
const OTHER_WHATSAPP_TOKEN = 'EAAGwhatsappSystemUserToken0002';
const PAGE_TOKEN = 'EAAGmessengerPageToken000000001';
const INSTAGRAM_TOKEN = 'IGAAinstagramUserToken000000001';
const OTHER_INSTAGRAM_TOKEN = 'IGAAinstagramUserToken000000002';

describe('MetaAccountsService (Graph reads)', () => {
  const graph = new FakeGraph();
  let configured = true;
  let taken = false;
  let stored: AccountWithNames | undefined;
  const marked: { id: string; detail: string }[] = [];
  const updated: { id: string; values: Record<string, unknown> }[] = [];

  const repository = {
    markError: async (_tx: unknown, id: string, detail: string) => {
      marked.push({ id, detail });
    },
    update: async (_tx: unknown, id: string, values: Record<string, unknown>) => {
      updated.push({ id, values });
    },
    locate: async () =>
      taken ? { id: 'x', brandId: BRAND, platform: 'whatsapp', externalId: NUMBER } : undefined,
    find: async () => stored,
    activity: async () => ({
      lastReplyAt: new Date('2026-10-11T10:00:00.000Z'),
      failedSends: 1,
      refusedSends: 2,
      openTickets: 3,
    }),
  } as unknown as MetaRepository;

  const service = new MetaAccountsService({
    db: {} as Db,
    repository,
    keyring,
    graph: () =>
      new GraphClient({
        root: graph.facebookRoot,
        instagramRoot: graph.instagramRoot,
        allowCidrs: ['127.0.0.0/8'],
      }),
    app: { secrets: async () => (configured ? ['app-secret'] : []) },
    now: () => new Date('2026-10-11T12:00:00.000Z'),
  });

  const row = (
    platform: MetaPlatform,
    externalId: string,
    token: string,
    overrides: Partial<MetaAccountRow> = {},
  ): AccountWithNames => ({
    departmentName: 'Support',
    tokenUpdatedByName: null,
    account: {
      id: '01924f00-0000-7000-8000-0000000000aa',
      brandId: BRAND,
      platform,
      departmentId: DEPARTMENT,
      externalId,
      wabaId: platform === 'whatsapp' ? WABA : null,
      displayPhone: null,
      username: null,
      displayName: 'Helpdock',
      accessToken: encryptSecret(token, keyring),
      tokenKind:
        platform === 'whatsapp'
          ? 'system_user'
          : platform === 'messenger'
            ? 'page'
            : 'instagram_user',
      tokenExpiresAt: null,
      tokenRefreshedAt: null,
      tokenUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
      tokenUpdatedBy: null,
      humanAgentEnabled: false,
      subscribedFields: [],
      subscribedAt: null,
      subscriptionCheckedAt: null,
      status: 'connected',
      lastEventAt: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...overrides,
    },
  });

  beforeAll(async () => {
    await graph.start();
    graph.connect({
      platform: 'whatsapp',
      id: NUMBER,
      name: 'Helpdock Support',
      displayPhone: '+1 555 0142',
      token: WHATSAPP_TOKEN,
      wabaId: WABA,
    });
    graph.connect({
      platform: 'whatsapp',
      id: OTHER_NUMBER,
      name: 'Other number',
      displayPhone: '+1 555 0100',
      token: OTHER_WHATSAPP_TOKEN,
      wabaId: OTHER_WABA,
    });
    graph.connect({ platform: 'messenger', id: PAGE, name: 'Helpdock', token: PAGE_TOKEN });
    graph.connect({
      platform: 'instagram',
      id: INSTAGRAM,
      name: 'Helpdock',
      username: 'helpdock',
      token: INSTAGRAM_TOKEN,
    });
    graph.connect({
      platform: 'instagram',
      id: OTHER_INSTAGRAM,
      name: 'Other',
      username: 'other',
      token: OTHER_INSTAGRAM_TOKEN,
    });
  });

  afterAll(async () => {
    await graph.stop();
  });

  beforeEach(() => {
    graph.reset();
    configured = true;
    taken = false;
    stored = undefined;
    marked.length = 0;
    updated.length = 0;
  });

  describe('testToken', () => {
    it('names a WhatsApp number by what Meta verified, and a token that never expires', async () => {
      const result = await service.testToken({
        platform: 'whatsapp',
        externalId: NUMBER,
        accessToken: WHATSAPP_TOKEN,
      });

      expect(metaTestResultSchema.parse(result)).toEqual({
        ok: true,
        platform: 'whatsapp',
        externalId: NUMBER,
        name: 'Helpdock Support',
      });
      expect(graph.callsTo(`/${NUMBER}`)[0]).toMatchObject({
        root: 'facebook',
        query: { fields: 'id,display_phone_number,verified_name' },
        token: WHATSAPP_TOKEN,
      });
    });

    it('finds the number’s business account through the token, which is what it subscribes on', async () => {
      await service.testToken({
        platform: 'whatsapp',
        externalId: NUMBER,
        accessToken: WHATSAPP_TOKEN,
      });

      expect(graph.callsTo('/phone_numbers').map((call) => call.path)).toContain(
        `/${WABA}/phone_numbers`,
      );
    });

    it('refuses a token that reads the number but cannot list the business account that owns it', async () => {
      graph.failures.push({
        status: 403,
        body: { error: { code: 200, message: '(#200) Requires whatsapp_business_management' } },
        match: /phone_numbers/,
      });

      await expect(
        service.testToken({
          platform: 'whatsapp',
          externalId: NUMBER,
          accessToken: WHATSAPP_TOKEN,
        }),
      ).rejects.toMatchObject({ reason: 'token-other-account' });
    });

    it('reports the end of a Page token that Meta says ends', async () => {
      // The stand-in judges expiry by the real clock, so the date is relative to it.
      const endsAt = new Date(Math.floor(Date.now() / 1_000) * 1_000 + 2 * 60 * 60 * 1_000);
      graph.setTokenExpiry(PAGE_TOKEN, endsAt);

      try {
        const result = await service.testToken({
          platform: 'messenger',
          externalId: PAGE,
          accessToken: PAGE_TOKEN,
        });

        expect(result).toMatchObject({
          ok: true,
          name: 'Helpdock',
          tokenExpiresAt: endsAt.toISOString(),
        });
      } finally {
        graph.setTokenExpiry(PAGE_TOKEN, null);
      }
    });

    it('asks Instagram for its own account, and dates its 60-day token from now', async () => {
      const result = await service.testToken({
        platform: 'instagram',
        externalId: INSTAGRAM,
        accessToken: INSTAGRAM_TOKEN,
      });

      expect(result).toEqual({
        ok: true,
        platform: 'instagram',
        externalId: INSTAGRAM,
        name: 'Helpdock',
        username: 'helpdock',
        tokenExpiresAt: '2026-12-10T12:00:00.000Z',
      });
      expect(graph.callsTo('/me')[0]).toMatchObject({ root: 'instagram', token: INSTAGRAM_TOKEN });
    });

    it('says Meta refused a token it does not know, in Meta’s words', async () => {
      const result = await service.testToken({
        platform: 'messenger',
        externalId: PAGE,
        accessToken: 'EAAGsomethingMetaHasNeverIssued',
      });

      expect(result).toMatchObject({ ok: false, kind: 'token' });
      expect(result.ok ? '' : result.detail).toMatch(/Invalid OAuth access token/);
    });

    it('says a token Meta calls expired is refused, not that it belongs to another account', async () => {
      graph.expiredTokens.add(WHATSAPP_TOKEN);

      const result = await service.testToken({
        platform: 'whatsapp',
        externalId: NUMBER,
        accessToken: WHATSAPP_TOKEN,
      });

      expect(result).toMatchObject({ ok: false, kind: 'token' });
    });

    it('refuses an Instagram token pasted for Messenger, and a Page token pasted for Instagram', async () => {
      await expect(
        service.testToken({
          platform: 'messenger',
          externalId: PAGE,
          accessToken: INSTAGRAM_TOKEN,
        }),
      ).rejects.toMatchObject({ reason: 'platform-mismatch' });
      await expect(
        service.testToken({
          platform: 'instagram',
          externalId: INSTAGRAM,
          accessToken: PAGE_TOKEN,
        }),
      ).rejects.toMatchObject({ reason: 'platform-mismatch' });
      await expect(
        service.testToken({
          platform: 'whatsapp',
          externalId: NUMBER,
          accessToken: INSTAGRAM_TOKEN,
        }),
      ).rejects.toBeInstanceOf(MetaFailure);
    });

    it('refuses a good token for a number or an account it does not open', async () => {
      await expect(
        service.testToken({
          platform: 'whatsapp',
          externalId: OTHER_NUMBER,
          accessToken: WHATSAPP_TOKEN,
        }),
      ).rejects.toMatchObject({ reason: 'token-other-account' });
      await expect(
        service.testToken({
          platform: 'instagram',
          externalId: OTHER_INSTAGRAM,
          accessToken: INSTAGRAM_TOKEN,
        }),
      ).rejects.toMatchObject({ reason: 'token-other-account' });
    });

    it('says Meta could not be reached when Graph answers a 5xx or nonsense', async () => {
      graph.failures.push({
        status: 503,
        body: { error: { code: 2, message: 'Service unavailable' } },
      });
      const down = await service.testToken({
        platform: 'whatsapp',
        externalId: NUMBER,
        accessToken: WHATSAPP_TOKEN,
      });
      graph.failures.push({ status: 200, body: { unexpected: true }, match: /GET \/1065/ });
      const nonsense = await service.testToken({
        platform: 'whatsapp',
        externalId: NUMBER,
        accessToken: WHATSAPP_TOKEN,
      });

      expect(down).toMatchObject({ ok: false, kind: 'connect' });
      expect(nonsense).toMatchObject({ ok: false, kind: 'connect' });
    });

    it('treats a token no header can carry as one Meta did not issue', async () => {
      const result = await service.testToken({
        platform: 'whatsapp',
        externalId: NUMBER,
        accessToken: 'EAAG not-a-token-0000',
      });

      expect(result).toMatchObject({ ok: false, kind: 'token' });
      expect(graph.calls).toHaveLength(0);
    });

    it('refuses before asking Meta anything when no app secret is set', async () => {
      configured = false;

      await expect(
        service.testToken({
          platform: 'whatsapp',
          externalId: NUMBER,
          accessToken: WHATSAPP_TOKEN,
        }),
      ).rejects.toMatchObject({ reason: 'app-not-configured' });
      expect(graph.calls).toHaveLength(0);
    });

    it('refuses an account that is already connected before asking Meta anything', async () => {
      taken = true;

      await expect(
        service.testToken({
          platform: 'whatsapp',
          externalId: NUMBER,
          accessToken: WHATSAPP_TOKEN,
        }),
      ).rejects.toMatchObject({ reason: 'account-taken' });
      expect(graph.calls).toHaveLength(0);
    });

    it('never repeats the token it was given', async () => {
      const answers = await Promise.all([
        service.testToken({
          platform: 'whatsapp',
          externalId: NUMBER,
          accessToken: WHATSAPP_TOKEN,
        }),
        service.testToken({
          platform: 'messenger',
          externalId: PAGE,
          accessToken: 'EAAGsomethingMetaHasNeverIssued',
        }),
      ]);

      expect(JSON.stringify(answers)).not.toContain(WHATSAPP_TOKEN);
      expect(JSON.stringify(answers)).not.toContain('EAAGsomethingMetaHasNeverIssued');
    });
  });

  describe('test', () => {
    it('reads the account with the stored token and writes nothing', async () => {
      stored = row('instagram', INSTAGRAM, INSTAGRAM_TOKEN, {
        tokenExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
      });

      const result = await service.test({} as DbTransaction, stored.account.id);

      expect(result).toEqual({
        ok: true,
        platform: 'instagram',
        externalId: INSTAGRAM,
        name: 'Helpdock',
        username: 'helpdock',
        tokenExpiresAt: '2026-12-01T00:00:00.000Z',
      });
      expect(graph.callsTo('/me')[0]?.token).toBe(INSTAGRAM_TOKEN);
    });

    it('answers a token Meta has invalidated rather than throwing it', async () => {
      stored = row('messenger', PAGE, PAGE_TOKEN);
      graph.expiredTokens.add(PAGE_TOKEN);

      const result = await service.test({} as DbTransaction, stored.account.id);

      expect(result).toMatchObject({ ok: false, kind: 'token' });
      expect(result.ok ? '' : result.detail).toMatch(/session|expired|token/i);
    });

    it('answers a number the stored token no longer opens as refused, not as thrown', async () => {
      stored = row('whatsapp', OTHER_NUMBER, WHATSAPP_TOKEN);

      const result = await service.test({} as DbTransaction, stored.account.id);

      expect(result).toMatchObject({ ok: false, kind: 'refused' });
    });

    it('says there is no such account for an id that is not in the brand', async () => {
      await expect(service.test({} as DbTransaction, 'missing')).rejects.toThrow(
        /No such Meta account/,
      );
    });
  });

  describe('status', () => {
    it('gives the row’s facts, Meta’s live answer and the Activity card', async () => {
      stored = row('messenger', PAGE, PAGE_TOKEN, {
        lastEventAt: new Date('2026-10-11T11:00:00.000Z'),
        subscribedFields: ['messages'],
        subscribedAt: new Date('2026-10-11T09:00:00.000Z'),
      });
      graph.subscribe(PAGE);

      const status = metaAccountStatusResponseSchema.parse(
        await service.status({} as DbTransaction, stored.account.id),
      );

      expect(status).toMatchObject({
        status: 'connected',
        health: 'healthy',
        tokenValid: true,
        liveError: null,
        subscribedFields: ['messages'],
        activity: { failedSends: 1, refusedSends: 2, openTickets: 3 },
      });
      expect(status.subscribedApps?.[0]).toMatchObject({ name: 'Helpdock' });
      expect(status.subscribedApps?.[0]?.subscribedFields).toContain('message_deliveries');
    });

    it('reads a WhatsApp number’s subscription on its business account, not on the number', async () => {
      stored = row('whatsapp', NUMBER, WHATSAPP_TOKEN);
      graph.subscribe(WABA);

      const status = await service.status({} as DbTransaction, stored.account.id);

      expect(status).toMatchObject({ tokenValid: true, liveError: null });
      expect(status.subscribedApps).toHaveLength(1);
      expect(graph.callsTo('/subscribed_apps').map((call) => call.path)).toEqual([
        `/${WABA}/subscribed_apps`,
      ]);
    });

    it('says to connect a WhatsApp number again when it has no business account on record', async () => {
      stored = row('whatsapp', NUMBER, WHATSAPP_TOKEN, { wabaId: null });

      const status = await service.status({} as DbTransaction, stored.account.id);

      expect(status).toMatchObject({ tokenValid: true, subscribedApps: null });
      expect(status.liveError).toMatch(/disconnect it and connect it again/i);
      expect(graph.callsTo('/subscribed_apps')).toHaveLength(0);
    });

    it('checks an Instagram token by reading the account, which has no debug_token', async () => {
      stored = row('instagram', INSTAGRAM, INSTAGRAM_TOKEN);
      graph.subscribe(INSTAGRAM);

      const status = await service.status({} as DbTransaction, stored.account.id);

      expect(status).toMatchObject({ tokenValid: true });
      expect(graph.callsTo('/debug_token')).toHaveLength(0);
    });

    it('still calls a token valid when only the subscribed-apps read failed', async () => {
      stored = row('messenger', PAGE, PAGE_TOKEN);
      graph.failures.push({
        status: 503,
        body: { error: { code: 2, message: 'Service unavailable' } },
        match: /subscribed_apps/,
      });

      const status = await service.status({} as DbTransaction, stored.account.id);

      expect(status).toMatchObject({ tokenValid: true, subscribedApps: null });
      expect(status.liveError).toMatch(/unavailable/i);
    });

    it('says a dead token is dead and does not ask about subscriptions with it', async () => {
      stored = row('whatsapp', NUMBER, WHATSAPP_TOKEN, { status: 'token_expired' });
      graph.expiredTokens.add(WHATSAPP_TOKEN);

      const status = await service.status({} as DbTransaction, stored.account.id);

      expect(status).toMatchObject({
        status: 'token_expired',
        health: 'failing',
        tokenValid: false,
        subscribedApps: null,
      });
      expect(graph.callsTo('/subscribed_apps')).toHaveLength(0);
    });

    it('answers null with the reason when Graph could not be asked, and still answers', async () => {
      stored = row('messenger', PAGE, PAGE_TOKEN);
      // The token check and the subscribed-apps read both fail.
      for (let call = 0; call < 2; call += 1) {
        graph.failures.push({
          status: 503,
          body: { error: { code: 2, message: 'Service unavailable' } },
        });
      }

      const status = await service.status({} as DbTransaction, stored.account.id);

      expect(status.tokenValid).toBeNull();
      expect(status.subscribedApps).toBeNull();
      expect(status.liveError).toMatch(/unavailable/i);
      expect(status.activity.openTickets).toBe(3);
    });
  });

  describe('subscribe', () => {
    const context = {
      tx: { insert: () => ({ values: async () => undefined }) } as unknown as DbTransaction,
      brandId: BRAND,
      actor: { userId: '01924f00-0000-7000-8000-0000000000bb' },
    } as unknown as Parameters<MetaAccountsService['subscribe']>[0];

    it('subscribes a WhatsApp number on its business account and names no fields', async () => {
      stored = row('whatsapp', NUMBER, WHATSAPP_TOKEN);

      const result = await service.subscribe(context, stored.account.id);

      expect(result).toMatchObject({ ok: true, subscribedFields: ['messages'] });
      const [post] = graph.callsTo('/subscribed_apps');
      expect(post).toMatchObject({ method: 'POST', path: `/${WABA}/subscribed_apps` });
      expect(post?.query.subscribed_fields).toBeUndefined();
    });

    it('subscribes a Page on the Page, naming the fields', async () => {
      stored = row('messenger', PAGE, PAGE_TOKEN);

      await service.subscribe(context, stored.account.id);

      const [post] = graph.callsTo('/subscribed_apps');
      expect(post).toMatchObject({ method: 'POST', path: `/${PAGE}/subscribed_apps` });
      expect(post?.query.subscribed_fields).toContain('messages');
    });

    it('answers a WhatsApp number with no business account on record without asking Meta', async () => {
      stored = row('whatsapp', NUMBER, WHATSAPP_TOKEN, { wabaId: null });

      const result = await service.subscribe(context, stored.account.id);

      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.detail).toMatch(/disconnect it and connect it again/i);
      expect(graph.callsTo('/subscribed_apps')).toHaveLength(0);
      expect(marked).toHaveLength(1);
    });
  });
});
