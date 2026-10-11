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
const signed = (body: unknown, secret = APP_SECRET) => {
  const raw = bytesOf(body);
  return { raw, signature: hubSignature(raw, secret) };
};

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
      secrets: async () => [APP_SECRET, INSTAGRAM_SECRET],
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
    const { service } = harness({
      app: { secrets: async () => [], currentVerifyToken: async () => '' },
    });

    await expect(
      service.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('MetaWebhookService.receive', () => {
  describe('the signature', () => {
    it('is checked before anything is looked up or filed', async () => {
      const located = vi.fn();
      const { service, received } = harness({ repository: { locate: located } });
      const body = whatsappText();

      await expect(
        service.receive(bytesOf(body), hubSignature(bytesOf(body), 'wrong'), body),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(located).not.toHaveBeenCalled();
      expect(received).toEqual([]);
    });

    it.each([
      ['missing', undefined],
      ['not a signature', 'sha256=zz'],
      ['the wrong scheme', 'sha1=abcd'],
    ])('refuses a header that is %s', async (_name, header) => {
      const { service, received } = harness();
      const { raw } = signed(whatsappText());

      await expect(service.receive(raw, header, whatsappText())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(received).toEqual([]);
    });

    it('refuses a body that was changed after it was signed', async () => {
      const { service, received } = harness();
      const body = whatsappText({ text: 'Hello' });
      const { signature } = signed(body);
      const tampered = bytesOf(whatsappText({ text: 'Hellp' }));

      await expect(service.receive(tampered, signature, body)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(received).toEqual([]);
    });

    it('refuses a request whose raw body was not kept', async () => {
      const { service } = harness();
      const body = whatsappText();

      await expect(service.receive(undefined, signed(body).signature, body)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('accepts the Instagram app secret as well as the app secret', async () => {
      const { service, received } = harness();
      const body = whatsappText();
      const { raw, signature } = signed(body, INSTAGRAM_SECRET);

      const result = await service.receive(raw, signature, body);

      expect(result.verdict).toBe('ok');
      expect(received).toHaveLength(1);
    });

    it('verifies nothing while the install has no app secret, whatever the signature', async () => {
      const { service, received } = harness({
        app: { secrets: async () => [], currentVerifyToken: async () => VERIFY_TOKEN },
      });
      const body = whatsappText();

      await expect(
        service.receive(bytesOf(body), hubSignature(bytesOf(body), ''), body),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(received).toEqual([]);
    });

    it('says why once a minute, not once a request', async () => {
      const { service, warnings, advance } = harness();
      const refuse = () =>
        service.receive(Buffer.from('{}'), 'sha256='.concat('0'.repeat(64)), {}).catch(() => {});

      await refuse();
      await refuse();
      expect(warnings).toEqual(['meta webhook refused: bad or missing signature']);

      advance(60_001);
      await refuse();
      expect(warnings).toHaveLength(2);
    });

    it('says an unconfigured install is unconfigured, apart from a wrong signature', async () => {
      const { service, warnings } = harness({
        app: { secrets: async () => [], currentVerifyToken: async () => '' },
      });

      await service.receive(Buffer.from('{}'), undefined, {}).catch(() => {});

      expect(warnings).toEqual(['meta webhook refused: no Meta app secret is set']);
    });
  });

  describe('the envelope', () => {
    it('answers 400 for a signed body that is not a Meta webhook', async () => {
      const { service, received } = harness();
      const body = { object: 'something_else', entry: [] };
      const { raw, signature } = signed(body);

      await expect(service.receive(raw, signature, body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(received).toEqual([]);
    });

    it('is fine with a signed delivery that holds nothing to file', async () => {
      const { service, received } = harness();
      const body = { object: 'page', entry: [] };
      const { raw, signature } = signed(body);

      await expect(service.receive(raw, signature, body)).resolves.toMatchObject({
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
      const { raw, signature } = signed(body);

      await expect(service.receive(raw, signature, body)).resolves.toMatchObject({
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
      const { raw, signature } = signed(body);

      const result = await service.receive(raw, signature, body);

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
      const { raw, signature } = signed(body);

      const result = await service.receive(raw, signature, body);

      expect(result.routes.map((route) => route.status)).toEqual(['unknown-account', 'filed']);
      expect(received).toHaveLength(1);
      expect(result.verdict).toBe('ok');
    });

    it('is told apart: a page and a WhatsApp number with the same id are different accounts', async () => {
      const { service, received } = harness();
      const body = pageText({ pageId: NUMBER_A });
      const { raw, signature } = signed(body);

      const result = await service.receive(raw, signature, body);

      expect(result.routes.map((route) => route.status)).toEqual(['unknown-account']);
      expect(received).toEqual([]);
    });

    it('files nothing for a brand being deleted, and still answers ok', async () => {
      gone.add(BRAND_A);
      const { service, received } = harness();
      const body = whatsappText({ phoneNumberId: NUMBER_A });
      const { raw, signature } = signed(body);

      const result = await service.receive(raw, signature, body);

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
      const { raw, signature } = signed(body);

      const result = await service.receive(raw, signature, body);

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
      const { raw, signature } = signed(body);

      const result = await service.receive(raw, signature, body);

      expect(result.routes.map((route) => route.status)).toEqual(['failed', 'filed']);
      expect(result.verdict).toBe('ok');
      expect(error).toHaveBeenCalledOnce();
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
      const { raw, signature } = signed(body);

      await expect(service.receive(raw, signature, body)).resolves.toMatchObject({
        verdict: 'failed',
      });
    });
  });
});
