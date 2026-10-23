import { uuidv7 } from '@helpdock/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { totpRotationKey } from '../redis-keys.js';
import { ROTATION_TTL_SECONDS, TotpRotationStore } from './rotation-store.js';

/**
 * The staged secret of a rotation (#373). What the tests here prove is the
 * envelope: the TTL, the read-back, and that a rotation is spent by its own
 * account and nobody else's. That the secret inside is sealed is the caller's
 * contract — the store never sees it in the clear.
 */

const USER_ID = uuidv7();
const OTHER_ID = uuidv7();
const SEALED = 'sealed.v1.whatever';

let stub: RedisStub;
let store: TotpRotationStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  store = new TotpRotationStore(created.redis);
});

const start = () => store.create({ userId: USER_ID, secretEncrypted: SEALED });

describe('create', () => {
  it('stages the sealed secret against the account, never in the clear', async () => {
    const rotationId = await start();

    const raw = await stub.get(totpRotationKey(rotationId));
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ userId: USER_ID, secretEncrypted: SEALED });
  });

  it('expires after fifteen minutes, like an enrolment challenge', async () => {
    expect(stub.ttlOf(totpRotationKey(await start()))).toBe(ROTATION_TTL_SECONDS);
  });
});

describe('read', () => {
  it('answers the staged rotation while it lives', async () => {
    const rotationId = await start();

    const found = await store.read(rotationId);
    expect(found).toMatchObject({
      status: 'ok',
      rotation: { userId: USER_ID, secretEncrypted: SEALED },
    });
  });

  it('answers expired for an id it never issued, and for one that lapsed', async () => {
    await expect(store.read('0192c3f0-1a2b-7c3d-8e4f-0000000000aa')).resolves.toEqual({
      status: 'expired',
    });

    const rotationId = await start();
    await stub.del(totpRotationKey(rotationId));
    await expect(store.read(rotationId)).resolves.toEqual({ status: 'expired' });
  });
});

describe('consume', () => {
  it('spends the rotation for its own account', async () => {
    const rotationId = await start();
    await store.consume(rotationId, USER_ID);

    await expect(store.read(rotationId)).resolves.toEqual({ status: 'expired' });
  });

  it('leaves it alone for another account', async () => {
    const rotationId = await start();
    await store.consume(rotationId, OTHER_ID);

    expect(await stub.get(totpRotationKey(rotationId))).not.toBeNull();
  });
});
