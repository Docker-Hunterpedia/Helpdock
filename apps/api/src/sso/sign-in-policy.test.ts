import type { Keyring, Settings } from '@helpdock/config';
import { type Db, type DbTransaction, INSTALL_SCOPE_BRAND_ID, type User } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { SsoSignInPolicy } from './sign-in-policy.js';

const user = { id: 'user-1' } as User;

/** A request transaction that already reads the install scope; no query reaches a table. */
const requestTx = {
  execute: () => Promise.resolve([{ brand_ids: `{${INSTALL_SCOPE_BRAND_ID}}` }]),
} as unknown as DbTransaction;

const policyWith = (values: Record<string, unknown>) => {
  let poolUses = 0;
  const db = {
    transaction: () => {
      poolUses += 1;
      throw new Error('the pool was used');
    },
  } as unknown as Db;
  const settings = {
    isLockedByEnv: () => true,
    get: (key: string) => values[key],
  } as unknown as Settings;

  return {
    policy: new SsoSignInPolicy({ db, settings, keyring: {} as Keyring }),
    poolUses: () => poolUses,
  };
};

describe('SsoSignInPolicy.recoveryCodeBarred', () => {
  it('reads inside the transaction it is given and takes no second connection', async () => {
    const { policy, poolUses } = policyWith({
      'sso.enforced': true,
      'sso.breakGlassUserIds': ['user-1'],
    });

    await expect(policy.recoveryCodeBarred(user, requestTx)).resolves.toBe(true);
    expect(poolUses()).toBe(0);
  });

  it('is never barred while SSO is not enforced', async () => {
    const { policy, poolUses } = policyWith({ 'sso.enforced': false });

    await expect(policy.recoveryCodeBarred(user, requestTx)).resolves.toBe(false);
    expect(poolUses()).toBe(0);
  });
});
