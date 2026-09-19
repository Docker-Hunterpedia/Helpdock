import type { Db } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { readInstallState } from './install-state.js';

/** A pool that answers one `select … limit 1` with the rows it was given. */
const dbWith = (rows: readonly { id: string }[]): Db =>
  ({
    select: () => ({ from: () => ({ limit: () => Promise.resolve(rows) }) }),
    // A double for the one query shape this module makes; everything else on
    // `Db` would be a lie, so it is deliberately absent.
  }) as unknown as Db;

describe('readInstallState', () => {
  it('is fresh while there is nobody to sign in as', async () => {
    await expect(readInstallState(dbWith([]))).resolves.toBe('fresh');
  });

  it('is configured as soon as one account exists', async () => {
    await expect(readInstallState(dbWith([{ id: 'a' }]))).resolves.toBe('configured');
  });

  it('lets a database failure through, so its caller decides what it means', async () => {
    const unreachable = {
      select: () => {
        throw new Error('connection refused');
      },
    } as unknown as Db;

    await expect(readInstallState(unreachable)).rejects.toThrow('connection refused');
  });
});
