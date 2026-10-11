import type { Db } from '@helpdock/db';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrincipalResolver } from '../auth/principal-resolver.js';
import { hashApiKey } from './api-key-credential.js';
import {
  ApiKeyPrincipalResolver,
  apiKeyRateRule,
  apiKeyRefusedRule,
} from './api-key-principal-resolver.js';
import type { KnownApiKey } from './api-keys.repository.js';

const KEY = 'hd_live_test-key';
const ACTIVE: KnownApiKey = {
  id: '0192a000-0000-7000-8000-0000000000a1',
  brandId: '0192a000-0000-7000-8000-0000000000b1',
  scopes: ['tickets:read'],
  rateLimitPerMinute: 2,
  state: 'active',
};
const REVOKED: KnownApiKey = { ...ACTIVE, state: 'revoked' };
const EXPIRED: KnownApiKey = { ...ACTIVE, state: 'expired' };

const db = {} as Db;
const staff = {
  type: 'staff',
  id: '0192a000-0000-7000-8000-0000000000c1',
  brands: {},
  installAdmin: false,
} as const;

const setup = ({
  found = ACTIVE,
  allowed = true,
  gone = false,
}: {
  /** `null` is "no key has this hash". */
  found?: KnownApiKey | null;
  allowed?: boolean;
  /** The key's brand is `deleting` or `deleted`. */
  gone?: boolean;
} = {}) => {
  const findByHash = vi.fn(async () => found ?? undefined);
  const consume = vi.fn(async () => allowed);
  const fallback: PrincipalResolver = { resolve: vi.fn(async () => staff) };
  const audit = vi.fn(async () => {});
  const isGone = vi.fn(async () => gone);
  const warn = vi.fn();
  const error = vi.fn();
  const resolver = new ApiKeyPrincipalResolver({
    db,
    keys: { findByHash },
    limiter: { consume },
    fallback,
    refused: { audit },
    log: { warn, error },
    availability: { isGone },
  });
  return { resolver, findByHash, consume, fallback, audit, isGone, warn, error };
};

const withBearer = (token: string, ip = '203.0.113.7') => ({
  headers: { authorization: `Bearer ${token}` },
  ip,
});

describe('ApiKeyPrincipalResolver', () => {
  it('resolves a live key to an apikey principal bound to its brand and scopes', async () => {
    const { resolver, findByHash, consume } = setup();

    await expect(resolver.resolve(withBearer(KEY))).resolves.toEqual({
      type: 'apikey',
      id: ACTIVE.id,
      brandId: ACTIVE.brandId,
      scopes: ['tickets:read'],
    });
    expect(findByHash).toHaveBeenCalledWith(db, hashApiKey(KEY));
    expect(consume).toHaveBeenCalledWith(apiKeyRateRule(2), ACTIVE.id);
  });

  it('refuses a key nobody holds without trying the session', async () => {
    const { resolver, fallback } = setup({ found: null });

    await expect(resolver.resolve(withBearer(KEY))).resolves.toBeNull();
    expect(fallback.resolve).not.toHaveBeenCalled();
  });

  // F5 (M9-01): the brand's own admin issued the key, but an install admin has
  // switched the brand off. Its other surfaces answer 410; so does its key.
  it('answers 410 for a key whose brand is in its deletion grace, after spending its budget', async () => {
    const { resolver, consume } = setup({ gone: true });

    const refusal = await resolver.resolve(withBearer(KEY)).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(410);
    expect(consume).toHaveBeenCalledWith(apiKeyRateRule(2), ACTIVE.id);
  });

  it('throttles the key of a brand in its deletion grace like any other, without reading the brand', async () => {
    const { resolver, isGone } = setup({ gone: true, allowed: false });

    const refusal = await resolver.resolve(withBearer(KEY)).catch((error: unknown) => error);

    expect((refusal as HttpException).getStatus()).toBe(429);
    expect(isGone).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', REVOKED],
    ['expired', EXPIRED],
  ])(
    'keeps a %s key a 401, audited, even when its brand is in deletion grace',
    async (_state, ended) => {
      const { resolver, consume, audit, isGone } = setup({ found: ended, gone: true });

      await expect(resolver.resolve(withBearer(KEY))).resolves.toBeNull();

      expect(audit).toHaveBeenCalledOnce();
      expect(consume).not.toHaveBeenCalledWith(
        expect.objectContaining({ bucket: 'api-key' }),
        ACTIVE.id,
      );
      expect(isGone).not.toHaveBeenCalled();
    },
  );

  it('logs a refused unknown key by its prefix and the caller’s address, never the key itself', async () => {
    const { resolver, warn, audit } = setup({ found: null });

    await resolver.resolve(withBearer(KEY));

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { keyPrefix: 'hd_live_test', ip: '203.0.113.7', reason: 'unknown' },
      'API key refused',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(audit).not.toHaveBeenCalled();
  });

  it('audits a revoked key that is presented, once a minute per key, from one read', async () => {
    const { resolver, findByHash, warn, audit, consume } = setup({ found: REVOKED });

    await resolver.resolve(withBearer(KEY));
    consume.mockResolvedValueOnce(false);
    await resolver.resolve(withBearer(KEY));

    expect(findByHash).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ keyPrefix: 'hd_live_test', reason: 'revoked', keyId: ACTIVE.id }),
      'API key refused',
    );
    expect(consume).toHaveBeenCalledWith(apiKeyRefusedRule, ACTIVE.id);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(REVOKED, { prefix: 'hd_live_test', ip: '203.0.113.7' });
  });

  it('refuses an expired key as it does a revoked one, and says so', async () => {
    const { resolver, warn, audit, fallback } = setup({ found: EXPIRED });

    await expect(resolver.resolve(withBearer(KEY))).resolves.toBeNull();

    expect(fallback.resolve).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'expired', keyId: ACTIVE.id }),
      'API key refused',
    );
    expect(audit).toHaveBeenCalledWith(EXPIRED, { prefix: 'hd_live_test', ip: '203.0.113.7' });
  });

  it('still answers null, and logs it, when the refusal cannot be recorded', async () => {
    const { resolver, audit, error } = setup({ found: REVOKED });
    audit.mockRejectedValueOnce(new Error('database is down'));

    await expect(resolver.resolve(withBearer(KEY))).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'hd_live_test' }),
      'Could not record a refused API key',
    );
  });

  it('answers 429 once the key is over its per-minute budget', async () => {
    const { resolver } = setup({ allowed: false });

    const refusal = await resolver.resolve(withBearer(KEY)).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(429);
  });

  it('hands any other bearer to the session resolver', async () => {
    const { resolver, findByHash } = setup();

    await expect(resolver.resolve(withBearer('eyJ.access.token'))).resolves.toBe(staff);
    await expect(resolver.resolve({ headers: {} })).resolves.toBe(staff);
    expect(findByHash).not.toHaveBeenCalled();
  });
});

describe('apiKeyRateRule', () => {
  it('is a one-minute window sized by the key', () => {
    expect(apiKeyRateRule(600)).toEqual({ bucket: 'api-key', limit: 600, windowSeconds: 60 });
  });
});
