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
import type { ActiveApiKey } from './api-keys.repository.js';
import type { RefusedApiKey } from './refused-api-key.js';

const KEY = 'hd_live_test-key';
const ACTIVE: ActiveApiKey = {
  id: '0192a000-0000-7000-8000-0000000000a1',
  brandId: '0192a000-0000-7000-8000-0000000000b1',
  scopes: ['tickets:read'],
  rateLimitPerMinute: 2,
};

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
  refused,
}: {
  /** `null` is "no live key has this hash". */
  found?: ActiveApiKey | null;
  allowed?: boolean;
  /** What a lookup of the refused key finds: a revoked key, or (undefined) nothing. */
  refused?: RefusedApiKey;
} = {}) => {
  const findActiveByHash = vi.fn(async () => found ?? undefined);
  const consume = vi.fn(async () => allowed);
  const fallback: PrincipalResolver = { resolve: vi.fn(async () => staff) };
  const audit = vi.fn(async () => {});
  const find = vi.fn(async () => refused);
  const warn = vi.fn();
  const resolver = new ApiKeyPrincipalResolver({
    db,
    keys: { findActiveByHash },
    limiter: { consume },
    fallback,
    refused: { find, audit },
    log: { warn, error: vi.fn() },
  });
  return { resolver, findActiveByHash, consume, fallback, find, audit, warn };
};

const withBearer = (token: string, ip = '203.0.113.7') => ({
  headers: { authorization: `Bearer ${token}` },
  ip,
});

describe('ApiKeyPrincipalResolver', () => {
  it('resolves a live key to an apikey principal bound to its brand and scopes', async () => {
    const { resolver, findActiveByHash, consume } = setup();

    await expect(resolver.resolve(withBearer(KEY))).resolves.toEqual({
      type: 'apikey',
      id: ACTIVE.id,
      brandId: ACTIVE.brandId,
      scopes: ['tickets:read'],
    });
    expect(findActiveByHash).toHaveBeenCalledWith(db, hashApiKey(KEY));
    expect(consume).toHaveBeenCalledWith(apiKeyRateRule(2), ACTIVE.id);
  });

  it('refuses an unknown or revoked key without trying the session', async () => {
    const { resolver, fallback } = setup({ found: null });

    await expect(resolver.resolve(withBearer(KEY))).resolves.toBeNull();
    expect(fallback.resolve).not.toHaveBeenCalled();
  });

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

  it('audits a revoked key that is presented, once a minute per key', async () => {
    const revoked: RefusedApiKey = { id: ACTIVE.id, brandId: ACTIVE.brandId, reason: 'revoked' };
    const { resolver, warn, audit, consume } = setup({ found: null, refused: revoked });

    await resolver.resolve(withBearer(KEY));
    consume.mockResolvedValueOnce(false);
    await resolver.resolve(withBearer(KEY));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ keyPrefix: 'hd_live_test', reason: 'revoked', keyId: ACTIVE.id }),
      'API key refused',
    );
    expect(consume).toHaveBeenCalledWith(apiKeyRefusedRule, ACTIVE.id);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(revoked, { prefix: 'hd_live_test', ip: '203.0.113.7' });
  });

  it('refuses an expired key as it does a revoked one, and says so', async () => {
    const expired: RefusedApiKey = { id: ACTIVE.id, brandId: ACTIVE.brandId, reason: 'expired' };
    const { resolver, warn, audit, fallback } = setup({ found: null, refused: expired });

    await expect(resolver.resolve(withBearer(KEY))).resolves.toBeNull();

    expect(fallback.resolve).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'expired', keyId: ACTIVE.id }),
      'API key refused',
    );
    expect(audit).toHaveBeenCalledWith(expired, { prefix: 'hd_live_test', ip: '203.0.113.7' });
  });

  it('still answers null when the refusal cannot be recorded', async () => {
    const { resolver, find } = setup({ found: null });
    find.mockRejectedValueOnce(new Error('database is down'));

    await expect(resolver.resolve(withBearer(KEY))).resolves.toBeNull();
  });

  it('answers 429 once the key is over its per-minute budget', async () => {
    const { resolver } = setup({ allowed: false });

    const refusal = await resolver.resolve(withBearer(KEY)).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(429);
  });

  it('hands any other bearer to the session resolver', async () => {
    const { resolver, findActiveByHash } = setup();

    await expect(resolver.resolve(withBearer('eyJ.access.token'))).resolves.toBe(staff);
    await expect(resolver.resolve({ headers: {} })).resolves.toBe(staff);
    expect(findActiveByHash).not.toHaveBeenCalled();
  });
});

describe('apiKeyRateRule', () => {
  it('is a one-minute window sized by the key', () => {
    expect(apiKeyRateRule(600)).toEqual({ bucket: 'api-key', limit: 600, windowSeconds: 60 });
  });
});
