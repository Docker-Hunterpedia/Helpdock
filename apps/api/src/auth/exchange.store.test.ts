import { uuidv7 } from '@helpdock/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../testing/auth-redis.js';
import type { RedisStub } from '../testing/redis-stub.js';
import { EXCHANGE_TTL_SECONDS, ExchangeStore } from './exchange.store.js';
import { exchangeKey, hashToken } from './redis-keys.js';

const record = { userId: uuidv7(), familyId: uuidv7() };

let stub: RedisStub;
let store: ExchangeStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  store = new ExchangeStore(created.redis);
});

describe('ExchangeStore', () => {
  it('hands back a code and stores only its hash', async () => {
    const code = await store.issue(record);

    expect(stub.keys()).toEqual([exchangeKey(hashToken(code))]);
    expect(stub.keys().join(' ')).not.toContain(code);
  });

  it('holds no token: the redirect refers to a family, it does not carry a session', async () => {
    const code = await store.issue(record);

    const stored = await stub.get(exchangeKey(hashToken(code)));
    expect(JSON.parse(stored ?? '{}')).toEqual(record);
  });

  it('is single use', async () => {
    const code = await store.issue(record);

    await expect(store.consume(code)).resolves.toEqual(record);
    await expect(store.consume(code)).resolves.toBeNull();
  });

  it('lives only as long as a redirect takes', async () => {
    const code = await store.issue(record);

    expect(stub.ttlOf(exchangeKey(hashToken(code)))).toBe(EXCHANGE_TTL_SECONDS);
  });

  it('refuses a code it never issued', async () => {
    await expect(store.consume('made-up')).resolves.toBeNull();
  });

  it('refuses a record that is not one', async () => {
    const code = await store.issue(record);
    await stub.set(exchangeKey(hashToken(code)), '{"userId":"nope"}');

    await expect(store.consume(code)).resolves.toBeNull();
  });
});
