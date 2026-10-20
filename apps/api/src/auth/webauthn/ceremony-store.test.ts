import { uuidv7 } from '@helpdock/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { hashToken, webauthnCeremonyKey } from '../redis-keys.js';
import {
  WEBAUTHN_CEREMONY_TTL_SECONDS,
  type WebAuthnCeremony,
  WebAuthnCeremonyStore,
} from './ceremony-store.js';

const userId = uuidv7();
const familyId = uuidv7();
const ceremony: WebAuthnCeremony = {
  purpose: 'second-factor',
  challenge: 'A'.repeat(43),
  rpId: 'desk.example.com',
  userId,
};

let stub: RedisStub;
let store: WebAuthnCeremonyStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  store = new WebAuthnCeremonyStore(created.redis);
});

describe('WebAuthnCeremonyStore', () => {
  it('hands back a 256-bit id and stores only its hash, for five minutes', async () => {
    const id = await store.begin(ceremony);

    expect(Buffer.from(id, 'base64url')).toHaveLength(32);
    expect(stub.keys()).toEqual([webauthnCeremonyKey(hashToken(id))]);
    expect(stub.ttlOf(webauthnCeremonyKey(hashToken(id)))).toBe(WEBAUTHN_CEREMONY_TTL_SECONDS);
  });

  it('is single use', async () => {
    const id = await store.begin(ceremony);

    await expect(store.consume(id, 'second-factor', { userId })).resolves.toEqual(ceremony);
    await expect(store.consume(id, 'second-factor', { userId })).resolves.toBeNull();
  });

  it('refuses a ceremony of another purpose, and spends it all the same', async () => {
    const id = await store.begin(ceremony);

    await expect(store.consume(id, 'passwordless')).resolves.toBeNull();
    await expect(store.consume(id, 'second-factor', { userId })).resolves.toBeNull();
  });

  it('refuses a ceremony bound to another person', async () => {
    const id = await store.begin(ceremony);

    await expect(store.consume(id, 'second-factor', { userId: uuidv7() })).resolves.toBeNull();
  });

  it('refuses a bound ceremony presented without its binding', async () => {
    const id = await store.begin(ceremony);

    await expect(store.consume(id, 'second-factor')).resolves.toBeNull();
  });

  it('refuses a ceremony bound to another browser session', async () => {
    const id = await store.begin({ ...ceremony, purpose: 'register', familyId });

    await expect(store.consume(id, 'register', { userId, familyId: uuidv7() })).resolves.toBeNull();
  });

  it('completes an unbound ceremony only for an unbound caller', async () => {
    const id = await store.begin({ purpose: 'passwordless', challenge: 'B'.repeat(43), rpId: 'x' });

    await expect(store.consume(id, 'passwordless', { userId })).resolves.toBeNull();
  });

  it('refuses an id it never issued', async () => {
    await expect(store.consume('made-up', 'passwordless')).resolves.toBeNull();
  });

  it('refuses a record that is not one', async () => {
    const id = await store.begin(ceremony);
    await stub.set(webauthnCeremonyKey(hashToken(id)), '{"purpose":"second-factor"}');

    await expect(store.consume(id, 'second-factor', { userId })).resolves.toBeNull();
  });
});
