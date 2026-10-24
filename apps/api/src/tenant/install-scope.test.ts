import { type DbTransaction, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { withInstallScope } from './install-scope.js';

const brandA = '0192f3a0-0000-7000-8000-00000000000a';

describe('withInstallScope', () => {
  /** Answers the brand read, and records the brands each `set_config` wrote. */
  const txCarrying = (brandIds: string) => {
    const written: string[] = [];
    const tx = {
      execute: (query: { queryChunks: unknown[] }) => {
        const values = query.queryChunks.filter((chunk) => typeof chunk === 'string');
        const value = values.find((chunk) => String(chunk).startsWith('{'));
        if (value === undefined) {
          return Promise.resolve([{ value: brandIds }]);
        }
        written.push(String(value));
        return Promise.resolve([]);
      },
    } as unknown as DbTransaction;

    return { tx, written };
  };

  it('adds the install scope for fn and puts the brands back after', async () => {
    const { tx, written } = txCarrying(`{${brandA}}`);

    await expect(
      withInstallScope(tx, () => {
        expect(written).toEqual([`{${brandA},${INSTALL_SCOPE_BRAND_ID}}`]);
        return Promise.resolve('read');
      }),
    ).resolves.toBe('read');
    expect(written).toEqual([`{${brandA},${INSTALL_SCOPE_BRAND_ID}}`, `{${brandA}}`]);
  });

  it('puts the brands back when fn throws', async () => {
    const { tx, written } = txCarrying(`{${brandA}}`);

    await expect(withInstallScope(tx, () => Promise.reject(new Error('refused')))).rejects.toThrow(
      'refused',
    );
    expect(written.at(-1)).toBe(`{${brandA}}`);
  });

  it('leaves a transaction that already carries the install scope alone', async () => {
    const { tx, written } = txCarrying(`{${INSTALL_SCOPE_BRAND_ID}}`);

    await withInstallScope(tx, () => Promise.resolve());
    expect(written).toEqual([]);
  });
});

describe('withInstallScope restore failures', () => {
  it('rethrows the error of fn when the restore fails on an aborted transaction', async () => {
    let calls = 0;
    const tx = {
      execute: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([{ value: `{${brandA}}` }]);
        if (calls === 2) return Promise.resolve([]);
        return Promise.reject(new Error('current transaction is aborted'));
      },
    } as unknown as DbTransaction;

    await expect(withInstallScope(tx, () => Promise.reject(new Error('original')))).rejects.toThrow(
      'original',
    );
  });
});
