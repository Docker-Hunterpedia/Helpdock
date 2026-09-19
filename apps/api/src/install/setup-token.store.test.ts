import { uuidv7 } from '@helpdock/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../auth/redis-keys.js';
import { RedisStub } from '../testing/redis-stub.js';
import { SETUP_TOKEN_TTL_SECONDS, SetupTokenStore } from './setup-token.store.js';

const record = () => ({ userId: uuidv7(), email: 'lina@example.com', brandId: null });

const store = (): { stub: RedisStub; tokens: SetupTokenStore } => {
  const stub = new RedisStub();

  return { stub, tokens: new SetupTokenStore(stub.asRedis()) };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('SetupTokenStore', () => {
  it('hands back a token that reads the record again', async () => {
    const { tokens } = store();
    const issued = record();

    const { token, expiresInSeconds } = await tokens.issue(issued);

    expect(expiresInSeconds).toBe(SETUP_TOKEN_TTL_SECONDS);
    await expect(tokens.read(token)).resolves.toEqual(issued);
  });

  it('never puts the token itself in a key', async () => {
    const { stub, tokens } = store();

    const { token } = await tokens.issue(record());

    // A `KEYS setup:*` on a compromised Redis must yield nothing presentable.
    expect(stub.keys()).toEqual([`setup:wizard:${hashToken(token)}`]);
    expect(stub.keys().join()).not.toContain(token);
  });

  it.each([undefined, '', 'not-a-token'])('reads %j as nothing', async (token) => {
    const { tokens } = store();

    await expect(tokens.read(token)).resolves.toBeNull();
  });

  it('records the brand step 2 created without extending the half hour', async () => {
    vi.useFakeTimers();
    const { tokens } = store();
    const issued = record();
    const { token } = await tokens.issue(issued);
    const brandId = uuidv7();

    vi.advanceTimersByTime(20 * 60 * 1000);
    await tokens.update(token, { ...issued, brandId });
    await expect(tokens.read(token)).resolves.toEqual({ ...issued, brandId });

    // The half hour runs from step 1, so a wizard left open overnight expires
    // whatever it was doing in the meantime.
    vi.advanceTimersByTime(11 * 60 * 1000);
    await expect(tokens.read(token)).resolves.toBeNull();
  });

  it('spends the token once, so a replayed finish finds nothing', async () => {
    const { tokens } = store();
    const issued = record();
    const { token } = await tokens.issue(issued);

    await expect(tokens.consume(token)).resolves.toEqual(issued);
    await expect(tokens.consume(token)).resolves.toBeNull();
    await expect(tokens.read(token)).resolves.toBeNull();
  });

  it.each([undefined, ''])('consumes %j as nothing', async (token) => {
    const { tokens } = store();

    await expect(tokens.consume(token)).resolves.toBeNull();
  });

  it('refuses a record it cannot read back, rather than honouring half of one', async () => {
    const { stub, tokens } = store();
    const { token } = await tokens.issue(record());
    const key = `setup:wizard:${hashToken(token)}`;

    await stub.set(key, 'not json');
    await expect(tokens.read(token)).resolves.toBeNull();

    await stub.set(key, JSON.stringify({ userId: 'not-a-uuid' }));
    await expect(tokens.read(token)).resolves.toBeNull();
  });
});
