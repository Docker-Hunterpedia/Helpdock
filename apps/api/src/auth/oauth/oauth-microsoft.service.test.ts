import { createHash } from 'node:crypto';
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import type { CustomFetch } from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import { createFakeMicrosoft, type FakeMicrosoft } from '../../testing/fake-oauth-providers.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { silentLogger } from '../../testing/silent-logger.js';
import { hashToken, oauthStateKey } from '../redis-keys.js';
import { OauthError, OauthService } from './oauth.service.js';
import { oauthRedirectUri } from './providers.js';

const APP_URL = 'https://support.example.com';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const TENANT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_TENANT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OID = '0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';

const noInvalidation = {
  subscribe: () => () => {},
  publish: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

let redis: ReturnType<typeof authRedis>['redis'];
let stub: RedisStub;
let settings: Settings;
let microsoft: FakeMicrosoft;

beforeEach(async () => {
  const created = authRedis();
  redis = created.redis;
  stub = created.stub;
  settings = createSettings({
    env: {},
    store: new InMemorySettingsStore(),
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY }),
    invalidation: noInvalidation,
  });
  microsoft = await createFakeMicrosoft({ tenantId: TENANT });
});

const configure = async (tenantId = TENANT): Promise<void> => {
  await settings.set('oauth.microsoft.clientId', 'client-id', { updatedBy: 'test' });
  await settings.set('oauth.microsoft.clientSecret', 'client-secret', { updatedBy: 'test' });
  if (tenantId !== '') {
    await settings.set('oauth.microsoft.tenantId', tenantId, { updatedBy: 'test' });
  }
};

const serviceOver = (transport: CustomFetch): OauthService =>
  new OauthService({ settings, redis, logger: silentLogger(), appUrl: APP_URL, transport });

/** A member of the trusted tenant whose domain Entra has verified: the claims a first link needs. */
const member = {
  tid: TENANT,
  oid: OID,
  email: 'lina@helpdock.test',
  xms_edov: true,
  acct: 0,
  name: 'Lina',
};

/** Starts a flow, then finishes it with the token the stand-in is told to issue. */
const flow = async (
  claims: Record<string, unknown>,
  token: { issuer?: string; audience?: string; nonce?: 'echo' | string } = {},
  fake: FakeMicrosoft = microsoft,
) => {
  let issued = '';
  const tokenRequests: { url: string; body: URLSearchParams }[] = [];
  const service = serviceOver((input, init) => {
    const isToken = String(input).endsWith('/token');
    if (isToken) {
      tokenRequests.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
    }
    return fake.transport(isToken ? issued : '')(input, init);
  });
  const { url, browserNonce } = await service.start('microsoft');
  const authorization = new URL(url);
  const nonce =
    token.nonce === undefined || token.nonce === 'echo'
      ? (authorization.searchParams.get('nonce') ?? '')
      : token.nonce;
  issued = await fake.idToken(claims, {
    ...(token.issuer === undefined ? {} : { issuer: token.issuer }),
    ...(token.audience === undefined ? {} : { audience: token.audience }),
    nonce,
  });
  const state = authorization.searchParams.get('state') ?? '';
  const complete = (overrides: { state?: string; browserNonce?: string | undefined } = {}) =>
    service.complete({
      provider: 'microsoft',
      code: 'auth-code',
      state: overrides.state ?? state,
      browserNonce: 'browserNonce' in overrides ? overrides.browserNonce : browserNonce,
    });

  return { service, authorization, state, browserNonce, tokenRequests, complete };
};

describe('Microsoft start', () => {
  it('is off without a tenant, a client id or a secret, which is what hides the button', async () => {
    const service = serviceOver(microsoft.transport(''));
    expect(await service.isEnabled('microsoft')).toBe(false);

    await settings.set('oauth.microsoft.clientId', 'client-id', { updatedBy: 'test' });
    expect(await service.isEnabled('microsoft')).toBe(false);

    await settings.set('oauth.microsoft.tenantId', TENANT, { updatedBy: 'test' });
    expect(await service.isEnabled('microsoft')).toBe(false);
    await expect(service.start('microsoft')).rejects.toBeInstanceOf(OauthError);

    await settings.set('oauth.microsoft.clientSecret', 'client-secret', { updatedBy: 'test' });
    expect(await service.isEnabled('microsoft')).toBe(true);
  });

  it('sends the browser to the pinned tenant with PKCE, a state and a nonce', async () => {
    await configure();
    const service = serviceOver(microsoft.transport(''));

    const { url, browserNonce } = await service.start('microsoft');
    const authorization = new URL(url);
    const stored = JSON.parse(
      (await stub.get(oauthStateKey(hashToken(authorization.searchParams.get('state') ?? '')))) ??
        '{}',
    ) as { codeVerifier: string; nonce: string; browserNonceHash: string };

    expect(authorization.origin + authorization.pathname).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    );
    expect(authorization.searchParams.get('client_id')).toBe('client-id');
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      oauthRedirectUri(APP_URL, 'microsoft'),
    );
    expect(authorization.searchParams.get('scope')).toBe('openid email profile');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(stored.codeVerifier).digest('base64url'),
    );
    expect(authorization.searchParams.get('nonce')).toBe(stored.nonce);
    expect(stored.browserNonceHash).toBe(hashToken(browserNonce));
    expect(url).not.toContain(stored.codeVerifier);
  });

  it('refuses a discovery document that names another issuer', async () => {
    await configure();
    const lying = await createFakeMicrosoft({
      tenantId: TENANT,
      discoveryIssuer: 'https://evil.test',
    });

    await expect(serviceOver(lying.transport('')).start('microsoft')).rejects.toBeDefined();
    expect(stub.keys().filter((key) => key.includes('oauth'))).toEqual([]);
  });

  it('refuses a discovery document that moves the token endpoint off Microsoft, so the secret never leaves', async () => {
    await configure();
    const lying = await createFakeMicrosoft({
      tenantId: TENANT,
      tokenEndpoint: 'https://evil.test/token',
    });

    await expect(serviceOver(lying.transport('')).start('microsoft')).rejects.toBeInstanceOf(
      OauthError,
    );
  });
});

describe('Microsoft complete', () => {
  beforeEach(configure.bind(null, TENANT));

  it('signs a member of the tenant in by tenant and object id, and vouches for a verified email', async () => {
    const { complete } = await flow(member);

    const { identity } = await complete();

    expect(identity).toEqual({
      provider: 'microsoft',
      subject: `${TENANT}:${OID}`,
      email: 'lina@helpdock.test',
      name: 'Lina',
      authoritative: true,
      hostedDomain: undefined,
      verifiedEmails: ['lina@helpdock.test'],
    });
  });

  it('sends the code verifier and the secret to the tenant token endpoint only', async () => {
    const { state, tokenRequests, complete } = await flow(member);
    const stored = JSON.parse((await stub.get(oauthStateKey(hashToken(state)))) ?? '{}') as {
      codeVerifier: string;
    };

    await complete();

    const [request] = tokenRequests;
    expect(tokenRequests).toHaveLength(1);
    expect(request?.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(request?.body.get('code')).toBe('auth-code');
    expect(request?.body.get('code_verifier')).toBe(stored.codeVerifier);
    expect(request?.body.get('client_secret')).toBe('client-secret');
    expect(request?.body.get('redirect_uri')).toBe(oauthRedirectUri(APP_URL, 'microsoft'));
  });

  it.each([
    ['no xms_edov claim', { xms_edov: undefined }],
    ['xms_edov false', { xms_edov: false }],
    ['a guest account (acct 1) with a verified domain', { acct: 1 }],
    ['no acct claim, so a guest cannot be told from a member', { acct: undefined }],
  ])(
    'does not vouch for the address with %s, and verifies none for an invitation',
    async (_why, change) => {
      const { complete } = await flow({ ...member, ...change });

      const { identity } = await complete();

      expect(identity.authoritative).toBe(false);
      expect(identity.verifiedEmails).toEqual([]);
      expect(identity.subject).toBe(`${TENANT}:${OID}`);
    },
  );

  it.each([
    ['xms_edov as the string "true"', { xms_edov: 'true' }],
    ['acct as the string "0"', { acct: '0' }],
  ])('does not take %s for the claim, as the SSO preset does not', async (_why, change) => {
    const { complete } = await flow({ ...member, ...change });

    expect((await complete()).identity.authoritative).toBe(false);
  });

  it('does not take the editable sign-in name for a verified address', async () => {
    const { complete } = await flow({
      ...member,
      email: undefined,
      preferred_username: 'lina@helpdock.test',
    });

    const { identity } = await complete();

    expect(identity.email).toBe('lina@helpdock.test');
    expect(identity.authoritative).toBe(false);
  });

  it('refuses a token with no address at all', async () => {
    const { complete } = await flow({ ...member, email: undefined });

    await expect(complete()).rejects.toBeInstanceOf(OauthError);
  });

  it('refuses a token whose tid is another tenant, with a reason the screen can use', async () => {
    const { complete } = await flow({ ...member, tid: OTHER_TENANT }, { issuer: microsoft.issuer });

    await expect(complete()).rejects.toMatchObject({ reason: 'tenant-mismatch' });
  });

  it('refuses a token issued by another tenant', async () => {
    const { complete } = await flow(
      { ...member, tid: OTHER_TENANT },
      { issuer: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` },
    );

    await expect(complete()).rejects.toMatchObject({ reason: 'tenant-mismatch' });
  });

  it('refuses a token from the personal-accounts tenant even when it names itself as the issuer', async () => {
    const consumers = '9188040d-6c67-4c5b-b112-36a304b66dad';
    const { complete } = await flow(
      { ...member, tid: consumers },
      { issuer: `https://login.microsoftonline.com/${consumers}/v2.0` },
    );

    await expect(complete()).rejects.toMatchObject({ reason: 'tenant-mismatch' });
  });

  it('refuses an id token minted for another application', async () => {
    const { complete } = await flow(member, { audience: 'someone-elses-client' });

    await expect(complete()).rejects.toBeInstanceOf(OauthError);
  });

  it("refuses an id token that does not echo this flow's nonce", async () => {
    const { complete } = await flow(member, { nonce: 'a-nonce-from-another-flow' });

    await expect(complete()).rejects.toBeInstanceOf(OauthError);
  });

  it('takes the zero-padded object id of a personal account, which is not an RFC 9562 UUID', async () => {
    const { complete } = await flow({ ...member, oid: '00000000-0000-0000-66f3-3332eca7ea81' });

    expect((await complete()).identity.subject).toBe(
      `${TENANT}:00000000-0000-0000-66f3-3332eca7ea81`,
    );
  });

  it('refuses an object id that is not a GUID', async () => {
    const { complete } = await flow({ ...member, oid: 'lina' });

    await expect(complete()).rejects.toBeInstanceOf(OauthError);
  });

  it('refuses a replayed state: it is spent by the first callback', async () => {
    const { complete } = await flow(member);

    await complete();

    await expect(complete()).rejects.toThrow(/expired or was already completed/);
  });

  it('refuses a state this install never issued', async () => {
    const { complete } = await flow(member);

    await expect(complete({ state: 'forged' })).rejects.toBeInstanceOf(OauthError);
  });

  it.each([
    ['a browser that did not start the flow', 'another-browsers-nonce'],
    ['a browser with no cookie', undefined],
  ])('refuses a callback from %s before it asks Microsoft for anything', async (_who, nonce) => {
    const { tokenRequests, complete } = await flow(member);

    await expect(complete({ browserNonce: nonce })).rejects.toBeInstanceOf(OauthError);
    expect(tokenRequests).toEqual([]);
  });

  it('refuses a state started for another provider', async () => {
    await settings.set('oauth.google.clientId', 'g', { updatedBy: 'test' });
    await settings.set('oauth.google.clientSecret', 'g', { updatedBy: 'test' });
    const service = serviceOver(microsoft.transport(''));
    const { url, browserNonce } = await service.start('google');
    const state = new URL(url).searchParams.get('state') ?? '';

    await expect(
      service.complete({ provider: 'microsoft', code: 'c', state, browserNonce }),
    ).rejects.toBeInstanceOf(OauthError);
  });

  it('refuses when the tenant was changed after the flow started', async () => {
    const { complete } = await flow(member);
    await settings.set('oauth.microsoft.tenantId', OTHER_TENANT, { updatedBy: 'test' });

    await expect(complete()).rejects.toBeInstanceOf(OauthError);
  });

  it("keeps the provider's words out of the error it raises", async () => {
    const service = serviceOver(async () => new Response('secret-detail', { status: 500 }));

    const error = await service.start('microsoft').catch((caught: unknown) => caught);

    expect(String(error)).not.toContain('secret-detail');
  });
});

describe('Microsoft with personal accounts allowed (oauth.microsoft.allowConsumers)', () => {
  const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';
  const PERSONAL_OID = '00000000-0000-0000-66f3-3332eca7ea81';
  let common: FakeMicrosoft;
  const personal = {
    tid: CONSUMERS,
    oid: PERSONAL_OID,
    email: 'nour@outlook.test',
    // Even claims that would vouch for a member do not vouch for a personal account.
    xms_edov: true,
    acct: 0,
    name: 'Nour',
  };

  beforeEach(async () => {
    await configure();
    await settings.set('oauth.microsoft.allowConsumers', true, { updatedBy: 'test' });
    common = await createFakeMicrosoft({ tenantId: TENANT, common: true });
  });

  it('sends the browser to the common authority', async () => {
    const { authorization } = await flow(personal, {}, common);

    expect(authorization.pathname).toBe('/common/oauth2/v2.0/authorize');
  });

  it('accepts a personal account as the consumers tenant, binds it as <tid>:<oid>, and never links it by address', async () => {
    const { complete } = await flow(personal, {}, common);

    const { identity } = await complete();

    expect(identity).toMatchObject({
      subject: `${CONSUMERS}:${PERSONAL_OID}`,
      email: 'nour@outlook.test',
      authoritative: false,
      verifiedEmails: [],
    });
  });

  it('still accepts a verified member of the pinned tenant, who may link by address', async () => {
    const { complete } = await flow(member, {}, common);

    expect((await complete()).identity).toMatchObject({
      subject: `${TENANT}:${OID}`,
      authoritative: true,
    });
  });

  it('refuses a work tenant that is not the pinned one', async () => {
    const { complete } = await flow({ ...member, tid: OTHER_TENANT }, {}, common);

    await expect(complete()).rejects.toMatchObject({ reason: 'tenant-mismatch' });
  });

  it('refuses a token whose issuer is not that of its tid', async () => {
    const { complete } = await flow(
      personal,
      { issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` },
      common,
    );

    await expect(complete()).rejects.toBeInstanceOf(OauthError);
  });

  it('refuses a personal account again once the setting is off', async () => {
    const { complete } = await flow(personal, {}, common);
    await settings.set('oauth.microsoft.allowConsumers', false, { updatedBy: 'test' });

    await expect(complete()).rejects.toBeInstanceOf(OauthError);
  });
});

describe('Microsoft with personal accounts off (the default)', () => {
  it("refuses a personal account, whose issuer is the consumers tenant's own", async () => {
    await configure();
    const { complete } = await flow(
      { tid: '9188040d-6c67-4c5b-b112-36a304b66dad', oid: OID, email: 'nour@outlook.test' },
      {},
    );

    await expect(complete()).rejects.toMatchObject({ reason: 'tenant-mismatch' });
  });

  it('starts at the pinned tenant, not the common authority', async () => {
    await configure();
    const { authorization } = await flow(member);

    expect(authorization.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
  });
});
