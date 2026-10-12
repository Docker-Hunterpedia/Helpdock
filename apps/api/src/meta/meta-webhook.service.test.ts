import {
  batchOf,
  hubSignature,
  META_FIXTURE,
  type MetaRoute,
  pageText,
  whatsappText,
} from '@helpdock/channels';
import type { Db } from '@helpdock/db';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLocator } from './meta.repository.js';
import type { MetaInboundLog, MetaRouteResult } from './meta-inbound.service.js';
import {
  type MetaRouteReport,
  MetaWebhookService,
  type MetaWebhookServiceOptions,
  metaWebhookVerdict,
} from './meta-webhook.service.js';

const gone = new Set<string>();
vi.mock('../brands/brand-availability.js', () => ({
  isBrandGone: async (_db: unknown, brandId: string) => gone.has(brandId),
}));

const APP_SECRET = 'app-secret';
const INSTAGRAM_SECRET = 'instagram-secret';
const VERIFY_TOKEN = 'verify-token';
const BRAND_A = '01924f00-0000-7000-8000-0000000000a1';
const BRAND_B = '01924f00-0000-7000-8000-0000000000b1';
const NUMBER_A = META_FIXTURE.phoneNumberId;
const NUMBER_B = '106540352242999';

const accounts = new Map<string, AccountLocator>([
  [
    `whatsapp:${NUMBER_A}`,
    { id: 'acc-a', brandId: BRAND_A, platform: 'whatsapp', externalId: NUMBER_A },
  ],
  [
    `whatsapp:${NUMBER_B}`,
    { id: 'acc-b', brandId: BRAND_B, platform: 'whatsapp', externalId: NUMBER_B },
  ],
]);

const bytesOf = (body: unknown): Buffer => Buffer.from(JSON.stringify(body), 'utf8');

/** An install with no Meta app configured, whose handshake token is `verifyToken`. */
const unconfigured = (verifyToken: string): MetaWebhookServiceOptions['app'] => ({
  signingSecrets: async () => ({ appSecret: '', instagramAppSecret: '' }),
  currentVerifyToken: async () => verifyToken,
});

const harness = (overrides: Partial<MetaWebhookServiceOptions> = {}) => {
  const received: { locator: AccountLocator; route: MetaRoute }[] = [];
  const warnings: string[] = [];
  const log: MetaInboundLog = {
    info: () => undefined,
    warn: (_fields, message) => void warnings.push(message),
    error: () => undefined,
  };
  let clock = 1_000_000;
  const service = new MetaWebhookService({
    db: {} as Db,
    repository: {
      locate: async (_db, platform, externalId) => accounts.get(`${platform}:${externalId}`),
    },
    inbound: {
      receive: async (locator, route): Promise<MetaRouteResult> => {
        received.push({ locator, route });
        return {
          accountId: locator.id,
          brandId: locator.brandId,
          platform: locator.platform,
          events: route.events.map(() => ({ outcome: 'handled' })),
        };
      },
    },
    app: {
      signingSecrets: async () => ({
        appSecret: APP_SECRET,
        instagramAppSecret: INSTAGRAM_SECRET,
      }),
      currentVerifyToken: async () => VERIFY_TOKEN,
    },
    log,
    now: () => clock,
    ...overrides,
  });

  return {
    service,
    received,
    warnings,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

beforeEach(() => {
  gone.clear();
});

describe('metaWebhookVerdict', () => {
  const filed: MetaRouteReport = {
    status: 'filed',
    platform: 'whatsapp',
    accountId: 'a',
    brandId: BRAND_A,
    events: [],
  };
  const away: MetaRouteReport = {
    status: 'brand-gone',
    platform: 'whatsapp',
    accountId: 'b',
    brandId: BRAND_B,
  };
  const failed: MetaRouteReport = {
    status: 'failed',
    platform: 'whatsapp',
    accountId: 'c',
    brandId: BRAND_A,
  };
  const unknown: MetaRouteReport = { status: 'unknown-account', platform: 'messenger' };

  it.each([
    ['an empty batch', [], 'ok'],
    ['one account filed', [filed], 'ok'],
    ['a batch for a brand being deleted: the URL is the install’s, not the brand’s', [away], 'ok'],
    ['two accounts of brands being deleted', [away, away], 'ok'],
    [
      'a deleted brand beside a live one: the live brand’s events must not be refused',
      [away, filed],
      'ok',
    ],
    ['a deleted brand beside an unknown account', [away, unknown], 'ok'],
    ['nothing but an account that threw', [failed], 'failed'],
    ['every account threw', [failed, failed], 'failed'],
    ['an account that threw beside a deleted brand', [failed, away], 'failed'],
    [
      'one threw and another was filed: the filed one is not worth a retry loop',
      [failed, filed],
      'ok',
    ],
    ['an unknown account only', [unknown], 'ok'],
  ] as const)('answers %s', (_name, reports, verdict) => {
    expect(metaWebhookVerdict(reports)).toBe(verdict);
  });
});

describe('MetaWebhookService.verify', () => {
  it('echoes the challenge for the install’s verify token', async () => {
    const { service } = harness();

    await expect(
      service.verify({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      }),
    ).resolves.toBe('1158201444');
  });

  it.each([
    [
      'a wrong token',
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' },
    ],
    ['no token', { 'hub.mode': 'subscribe', 'hub.challenge': '1' }],
    [
      'a wrong mode',
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' },
    ],
    ['no challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }],
  ])('refuses %s', async (_name, query) => {
    const { service } = harness();

    await expect(service.verify(query)).rejects.toMatchObject({ status: 403 });
  });

  it('answers nobody while the install has no verify token', async () => {
    const { service } = harness({ app: unconfigured('') });

    await expect(
      service.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('MetaWebhookService.admit', () => {
  it('lets an address make 3,000 requests a minute and refuses the next', () => {
    const { service } = harness();

    const answers = Array.from({ length: 3_001 }, () => service.admit('203.0.113.7'));

    expect(answers.filter(Boolean)).toHaveLength(3_000);
    expect(answers.at(-1)).toBe(false);
  });

  it('counts each address on its own and starts a new minute afresh', () => {
    const { service, advance } = harness();
    for (let request = 0; request < 3_001; request += 1) {
      service.admit('203.0.113.7');
    }

    expect(service.admit('203.0.113.8')).toBe(true);
    advance(60_001);
    expect(service.admit('203.0.113.7')).toBe(true);
  });
});

describe('MetaWebhookService.authenticate', () => {
  it('says the app secret signed a body signed with it', async () => {
    const { service } = harness();
    const raw = bytesOf(whatsappText());

    await expect(service.authenticate(raw, hubSignature(raw, APP_SECRET))).resolves.toBe('app');
  });

  it('says the Instagram app secret signed a body signed with that', async () => {
    const { service } = harness();
    const raw = bytesOf(whatsappText());

    await expect(service.authenticate(raw, hubSignature(raw, INSTAGRAM_SECRET))).resolves.toBe(
      'instagram',
    );
  });

  it('says the app signed when one value is set for both, which is the app’s own secret', async () => {
    const { service } = harness({
      app: {
        signingSecrets: async () => ({ appSecret: APP_SECRET, instagramAppSecret: APP_SECRET }),
        currentVerifyToken: async () => VERIFY_TOKEN,
      },
    });
    const raw = bytesOf(whatsappText());

    await expect(service.authenticate(raw, hubSignature(raw, APP_SECRET))).resolves.toBe('app');
  });

  it('refuses a signature made with a secret that is neither', async () => {
    const { service } = harness();
    const raw = bytesOf(whatsappText());

    await expect(service.authenticate(raw, hubSignature(raw, 'wrong'))).resolves.toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['not a signature', 'sha256=zz'],
    ['the wrong scheme', 'sha1=abcd'],
  ])('refuses a header that is %s', async (_name, header) => {
    const { service } = harness();

    await expect(service.authenticate(bytesOf(whatsappText()), header)).resolves.toBeUndefined();
  });

  it('refuses a body that was changed after it was signed', async () => {
    const { service } = harness();
    const signature = hubSignature(bytesOf(whatsappText({ text: 'Hello' })), APP_SECRET);

    await expect(
      service.authenticate(bytesOf(whatsappText({ text: 'Hellp' })), signature),
    ).resolves.toBeUndefined();
  });

  it('verifies nothing while the install has no app secret, whatever the signature', async () => {
    const { service } = harness({ app: unconfigured(VERIFY_TOKEN) });
    const raw = bytesOf(whatsappText());

    await expect(service.authenticate(raw, hubSignature(raw, ''))).resolves.toBeUndefined();
  });

  it('says why once a minute, not once a request', async () => {
    const { service, warnings, advance } = harness();
    const refuse = () => service.authenticate(Buffer.from('{}'), `sha256=${'0'.repeat(64)}`);

    await refuse();
    await refuse();
    expect(warnings).toEqual(['meta webhook refused: bad or missing signature']);

    advance(60_001);
    await refuse();
    expect(warnings).toHaveLength(2);
  });

  it('says an unconfigured install is unconfigured, apart from a wrong signature', async () => {
    const { service, warnings } = harness({ app: unconfigured('') });

    await service.authenticate(Buffer.from('{}'), undefined);

    expect(warnings).toEqual(['meta webhook refused: no Meta app secret is set']);
  });
});

describe('MetaWebhookService.receive', () => {
  describe('the Instagram app secret', () => {
    it('vouches for an Instagram delivery', async () => {
      const { service } = harness();
      const body = { object: 'instagram', entry: [] };

      await expect(service.receive(body, 'instagram')).resolves.toMatchObject({ verdict: 'ok' });
    });

    it.each([
      ['a WhatsApp', whatsappText()],
      ['a Messenger', pageText()],
    ])('cannot forge %s delivery', async (_name, body) => {
      const { service, received, warnings } = harness();

      await expect(service.receive(body, 'instagram')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      expect(received).toEqual([]);
      expect(warnings).toEqual([
        'meta webhook refused: signed with the Instagram app secret for another platform',
      ]);
    });

    it('is not the only secret that vouches for an Instagram delivery: the app secret does too', async () => {
      const { service } = harness();

      await expect(
        service.receive({ object: 'instagram', entry: [] }, 'app'),
      ).resolves.toMatchObject({ verdict: 'ok' });
    });

    it('says why once a minute, not once a request', async () => {
      const { service, warnings, advance } = harness();
      const forge = () => service.receive(whatsappText(), 'instagram').catch(() => {});

      await forge();
      await forge();
      expect(warnings).toHaveLength(1);

      advance(60_001);
      await forge();
      expect(warnings).toHaveLength(2);
    });
  });

  describe('a delivery nobody authenticated', () => {
    it('is refused before anything is looked up or filed', async () => {
      const located = vi.fn();
      const { service, received } = harness({ repository: { locate: located } });

      await expect(service.receive(whatsappText(), undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      expect(located).not.toHaveBeenCalled();
      expect(received).toEqual([]);
    });
  });

  describe('the envelope', () => {
    it('answers 400 for a signed body that is not a Meta webhook', async () => {
      const { service, received } = harness();
      const body = { object: 'something_else', entry: [] };

      await expect(service.receive(body, 'app')).rejects.toBeInstanceOf(BadRequestException);
      expect(received).toEqual([]);
    });

    it('is fine with a signed delivery that holds nothing to file', async () => {
      const { service, received } = harness();
      const body = { object: 'page', entry: [] };

      await expect(service.receive(body, 'app')).resolves.toMatchObject({
        verdict: 'ok',
        routes: [],
      });
      expect(received).toEqual([]);
    });

    it('counts a field that names no account and carries on', async () => {
      const { service } = harness();
      const body = {
        object: 'whatsapp_business_account',
        entry: [{ id: META_FIXTURE.wabaId, changes: [{ field: 'account_update', value: {} }] }],
      };

      await expect(service.receive(body, 'app')).resolves.toMatchObject({
        verdict: 'ok',
        unrouted: 1,
      });
    });
  });

  describe('the accounts in a batch', () => {
    it('hands each account its own events, once, with the account it was found as', async () => {
      const { service, received } = harness();
      const body = batchOf(
        whatsappText({ text: 'one', phoneNumberId: NUMBER_A }),
        whatsappText({ text: 'two', phoneNumberId: NUMBER_B }),
        whatsappText({ text: 'three', phoneNumberId: NUMBER_A }),
      );

      const result = await service.receive(body, 'app');

      expect(result.verdict).toBe('ok');
      expect(received.map(({ locator }) => [locator.id, locator.brandId])).toEqual([
        ['acc-a', BRAND_A],
        ['acc-b', BRAND_B],
      ]);
      expect(received.map(({ route }) => route.events.length)).toEqual([2, 1]);
      expect(result.routes.map((route) => route.status)).toEqual(['filed', 'filed']);
    });

    it('passes over an account it does not know without refusing the rest', async () => {
      const { service, received } = harness();
      const body = batchOf(
        whatsappText({ phoneNumberId: '999' }),
        whatsappText({ phoneNumberId: NUMBER_A, wamid: 'wamid.second' }),
      );

      const result = await service.receive(body, 'app');

      expect(result.routes.map((route) => route.status)).toEqual(['unknown-account', 'filed']);
      expect(received).toHaveLength(1);
      expect(result.verdict).toBe('ok');
    });

    it('is told apart: a page and a WhatsApp number with the same id are different accounts', async () => {
      const { service, received } = harness();
      const body = pageText({ pageId: NUMBER_A });

      const result = await service.receive(body, 'app');

      expect(result.routes.map((route) => route.status)).toEqual(['unknown-account']);
      expect(received).toEqual([]);
    });

    it('files nothing for a brand being deleted, and still answers ok', async () => {
      gone.add(BRAND_A);
      const { service, received } = harness();
      const body = whatsappText({ phoneNumberId: NUMBER_A });

      const result = await service.receive(body, 'app');

      expect(result.verdict).toBe('ok');
      expect(result.routes.map((route) => route.status)).toEqual(['brand-gone']);
      expect(received).toEqual([]);
    });

    it('still files a live brand’s events beside a deleted brand’s, and answers ok', async () => {
      gone.add(BRAND_A);
      const { service, received } = harness();
      const body = batchOf(
        whatsappText({ phoneNumberId: NUMBER_A, wamid: 'wamid.a' }),
        whatsappText({ phoneNumberId: NUMBER_B, wamid: 'wamid.b' }),
      );

      const result = await service.receive(body, 'app');

      expect(result.verdict).toBe('ok');
      expect(result.routes.map((route) => route.status)).toEqual(['brand-gone', 'filed']);
      expect(received.map(({ locator }) => locator.brandId)).toEqual([BRAND_B]);
    });

    it('logs an account that throws and carries on with the rest', async () => {
      const error = vi.fn();
      const { service } = harness({
        log: { info: () => undefined, warn: () => undefined, error },
        inbound: {
          receive: async (locator, route) => {
            if (locator.id === 'acc-a') {
              throw new Error('database is on fire');
            }
            return {
              accountId: locator.id,
              brandId: locator.brandId,
              platform: locator.platform,
              events: route.events.map(() => ({ outcome: 'handled' as const })),
            };
          },
        },
      });
      const body = batchOf(
        whatsappText({ phoneNumberId: NUMBER_A, wamid: 'wamid.a' }),
        whatsappText({ phoneNumberId: NUMBER_B, wamid: 'wamid.b' }),
      );

      const result = await service.receive(body, 'app');

      expect(result.routes.map((route) => route.status)).toEqual(['failed', 'filed']);
      expect(result.verdict).toBe('ok');
      expect(error).toHaveBeenCalledOnce();
    });

    it('logs a failed query by its class, code and constraint, never by the words it was writing', async () => {
      const error = vi.fn();
      const database = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'ticket_messages_external_key',
      });
      const failedQuery = new Error('Failed query: insert … params: I want to return order 4471', {
        cause: database,
      });
      const { service } = harness({
        log: { info: () => undefined, warn: () => undefined, error },
        inbound: {
          receive: async () => {
            throw failedQuery;
          },
        },
      });

      await service.receive(whatsappText(), 'app');

      expect(error).toHaveBeenCalledOnce();
      const [fields] = error.mock.calls[0] ?? [];
      expect(fields).toMatchObject({
        platform: 'whatsapp',
        code: '23505',
        constraint: 'ticket_messages_external_key',
      });
      expect(fields).not.toHaveProperty('err');
      expect(JSON.stringify(fields)).not.toContain('order 4471');
    });

    it('asks Meta to redeliver when nothing could be filed', async () => {
      const { service } = harness({
        inbound: {
          receive: async () => {
            throw new Error('database is on fire');
          },
        },
      });
      const body = whatsappText();

      await expect(service.receive(body, 'app')).resolves.toMatchObject({
        verdict: 'failed',
      });
    });
  });
});
