import type { Db } from '@helpdock/db';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrincipalResolver } from '../auth/principal-resolver.js';
import { hashApiKey } from './api-key-credential.js';
import { ApiKeyPrincipalResolver, apiKeyRateRule } from './api-key-principal-resolver.js';
import type { ActiveApiKey } from './api-keys.repository.js';

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
}: {
  /** `null` is "no live key has this hash". */
  found?: ActiveApiKey | null;
  allowed?: boolean;
} = {}) => {
  const findActiveByHash = vi.fn(async () => found ?? undefined);
  const consume = vi.fn(async () => allowed);
  const fallback: PrincipalResolver = { resolve: vi.fn(async () => staff) };
  const resolver = new ApiKeyPrincipalResolver({
    db,
    keys: { findActiveByHash },
    limiter: { consume },
    fallback,
  });
  return { resolver, findActiveByHash, consume, fallback };
};

const withBearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

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
