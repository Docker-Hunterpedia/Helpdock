import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { withDryRun } from './read-only.js';

/**
 * The wrapper's contract with a fake transaction. That the database really
 * refuses a write inside it, and that the request's transaction survives, is
 * proved in `routing.integration.test.ts`.
 */

const fakeTransaction = () => {
  const statements: string[] = [];
  const savepoint = {
    execute: vi.fn(async (statement: { queryChunks?: unknown[] }) => {
      statements.push(JSON.stringify(statement.queryChunks ?? []));
    }),
  };
  const outcome: { rolledBack: boolean } = { rolledBack: false };
  const tx = {
    transaction: async (run: (inner: unknown) => Promise<unknown>) => {
      try {
        return await run(savepoint);
      } catch (error) {
        outcome.rolledBack = true;
        throw error;
      }
    },
  } as unknown as DbTransaction;

  return { tx, savepoint, statements, outcome };
};

describe('withDryRun', () => {
  it('makes the savepoint read-only before running, hands back the answer and rolls back', async () => {
    const { tx, savepoint, statements, outcome } = fakeTransaction();

    const answer = await withDryRun(tx, async (inner) => {
      expect(inner).toBe(savepoint);
      expect(statements.join('')).toContain('transaction_read_only');
      return 42;
    });

    expect(answer).toBe(42);
    expect(outcome.rolledBack).toBe(true);
  });

  it('lets a failure inside the run through, rolled back', async () => {
    const { tx, outcome } = fakeTransaction();

    await expect(
      withDryRun(tx, async () => {
        throw new Error('the database refused it');
      }),
    ).rejects.toThrow('the database refused it');

    expect(outcome.rolledBack).toBe(true);
  });
});
