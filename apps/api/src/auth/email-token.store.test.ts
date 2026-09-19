import { uuidv7 } from '@helpdock/db';
import type { EmailTokenPayload } from '@helpdock/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../testing/auth-redis.js';
import type { RedisStub } from '../testing/redis-stub.js';
import { EmailTokenStore } from './email-token.store.js';
import { emailTokenKey, hashToken } from './redis-keys.js';

const USER_ID = uuidv7();

const magicLink: EmailTokenPayload = {
  purpose: 'magic-link',
  userId: USER_ID,
  email: 'lina@helpdock.com',
  issuedAt: 1,
};

let stub: RedisStub;
let store: EmailTokenStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  store = new EmailTokenStore(created.redis);
});

describe('EmailTokenStore', () => {
  it('returns a token that is not what it stored', async () => {
    const token = await store.issue(magicLink, 600);

    expect(stub.keys()).toEqual([emailTokenKey(hashToken(token))]);
    expect(stub.keys().join(' ')).not.toContain(token);
  });

  it('gives back the payload for the right purpose', async () => {
    const token = await store.issue(magicLink, 600);

    await expect(store.consume(token, 'magic-link')).resolves.toEqual(magicLink);
  });

  it('spends it: the second click gets nothing', async () => {
    const token = await store.issue(magicLink, 600);
    await store.consume(token, 'magic-link');

    await expect(store.consume(token, 'magic-link')).resolves.toBeNull();
  });

  it('refuses a magic link presented as a password reset, and spends it either way', async () => {
    const token = await store.issue(magicLink, 600);

    await expect(store.consume(token, 'password-reset')).resolves.toBeNull();
    await expect(store.consume(token, 'magic-link')).resolves.toBeNull();
  });

  it('refuses a token it never issued', async () => {
    await expect(store.consume('made-up', 'magic-link')).resolves.toBeNull();
  });

  it('carries the lifetime it was given, so the link cannot outlive its purpose', async () => {
    const token = await store.issue(magicLink, 120);

    expect(stub.ttlOf(emailTokenKey(hashToken(token)))).toBe(120);
  });

  it('refuses a record that cannot be read back as a payload', async () => {
    const token = await store.issue(magicLink, 600);
    await stub.set(emailTokenKey(hashToken(token)), '{"purpose":"nonsense"}');

    await expect(store.consume(token, 'magic-link')).resolves.toBeNull();
  });
});
