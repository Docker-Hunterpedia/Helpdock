import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { silentLogger } from '../../testing/silent-logger.js';
import { SIGNING_KEY_LOCK } from '../redis-keys.js';
import { issueAccessToken, verifyAccessToken } from './access-token.js';
import { loadOrCreateSigningKeys, SIGNING_KEY_SETTING, SigningKeyError } from './signing-keys.js';

const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');

let stub: RedisStub;
let settings: Settings;

const load = (overrides: Partial<Parameters<typeof loadOrCreateSigningKeys>[0]> = {}) =>
  loadOrCreateSigningKeys({
    settings,
    redis: stub.asRedis(),
    logger: silentLogger(),
    waitTimeoutMs: 200,
    waitIntervalMs: 20,
    ...overrides,
  });

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  settings = createSettings({
    env: {},
    store: new InMemorySettingsStore(),
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY }),
    invalidation: {
      subscribe: () => () => {},
      publish: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
  });
});

const claimsFor = {
  userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
  sessionId: '0192c3f0-1a2b-7c3d-8e4f-00000000000b',
  familyId: '0192c3f0-1a2b-7c3d-8e4f-00000000000c',
  brands: {},
  installAdmin: false,
};

describe('loadOrCreateSigningKeys', () => {
  it('generates a pair on the first boot and stores it', async () => {
    const keys = await load();

    expect(keys.kid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await settings.get(SIGNING_KEY_SETTING)).not.toBe('');
  });

  it('reuses the stored pair on the next boot, so a session survives a restart', async () => {
    const first = await load();
    const token = await issueAccessToken(claimsFor, first);

    const second = await load();

    expect(second.kid).toBe(first.kid);
    await expect(verifyAccessToken(token, second)).resolves.toMatchObject({
      sub: claimsFor.userId,
    });
  });

  it('releases the lock, so a later boot is not blocked by the earlier one', async () => {
    await load();

    expect(stub.keys()).not.toContain(SIGNING_KEY_LOCK);
  });

  it('waits for the replica that holds the lock rather than generating a second pair', async () => {
    // Another replica has taken the lock and is about to store a key.
    await stub.set(SIGNING_KEY_LOCK, 'other-replica', 'EX', 30);
    const other = await loadOrCreateSigningKeys({
      settings,
      // A second stub, so this call is not the one that holds the lock above.
      redis: authRedis().redis,
      logger: silentLogger(),
    });

    const waited = await load();

    expect(waited.kid).toBe(other.kid);
  });

  it('gives up with a message when the lock holder never stores a key', async () => {
    await stub.set(SIGNING_KEY_LOCK, 'a replica that died', 'EX', 30);

    await expect(load()).rejects.toBeInstanceOf(SigningKeyError);
  });

  it('refuses a stored value that is not a key pair rather than serving with none', async () => {
    await settings.set(SIGNING_KEY_SETTING, 'not json', { updatedBy: 'test' });

    await expect(load()).rejects.toBeInstanceOf(SigningKeyError);
  });

  it('refuses a stored value whose shape is wrong', async () => {
    await settings.set(SIGNING_KEY_SETTING, JSON.stringify({ kid: 'k1' }), { updatedBy: 'test' });

    await expect(load()).rejects.toBeInstanceOf(SigningKeyError);
  });
});
