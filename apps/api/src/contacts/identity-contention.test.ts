import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { attachVerifiedIdentity, IdentityContentionError } from './identity.js';

// The lock itself is the integration test's business; here the change callback
// simply runs, so the holder re-read under the "lock" is what the fake returns.
vi.mock('./contact-profile-change.js', () => ({
  withContactProfileChange: async (_tx: unknown, _id: string, change: () => unknown) => change(),
}));

describe('attachVerifiedIdentity when the identifier keeps changing hands', () => {
  it('gives up with a named error after a bounded number of savepoint attempts', async () => {
    let reads = 0;
    let savepoints = 0;
    const select = () => ({
      from: () => ({
        where: () => ({
          // A different holder on every read, so the one under the lock is never the one read before.
          limit: async () => {
            reads += 1;
            return [{ id: 'identity', contactId: `holder-${reads}`, verified: false }];
          },
        }),
      }),
    });
    const tx = {
      select,
      transaction: async (fn: (savepoint: unknown) => unknown) => {
        savepoints += 1;
        return fn({ select });
      },
    } as unknown as DbTransaction;

    await expect(
      attachVerifiedIdentity(tx, 'brand', 'contact', {
        kind: 'email',
        value: 'mona@example.com',
        source: 'email.inbound',
      }),
    ).rejects.toBeInstanceOf(IdentityContentionError);
    expect(savepoints).toBe(5);
  });
});
