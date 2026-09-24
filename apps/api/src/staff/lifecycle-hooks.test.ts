import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { ASSIGNMENT_EVENTS } from '../assignment/assignment-events.js';
import type { Logger } from '../logging/logger.js';
import { AssignmentStaffLifecycleHooks } from './lifecycle-hooks.js';

const brandId = '01920000-0000-7000-8000-000000000b00';
const userId = '01920000-0000-7000-8000-0000000000a1';
const actorId = '01920000-0000-7000-8000-0000000000a9';

/** Records the outbox rows written through it. */
const fakeTx = () => {
  const rows: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        rows.push(values);
        return { returning: async () => [{ id: '01920000-0000-7000-8000-00000000000f' }] };
      },
    }),
  } as unknown as DbTransaction;

  return { tx, rows };
};

const logger = { debug: vi.fn() } as unknown as Logger;

describe('AssignmentStaffLifecycleHooks', () => {
  it.each(['onStaffDeactivated', 'onStaffScopeChanged'] as const)(
    '%s asks the worker to re-check their tickets, in the same transaction',
    async (hook) => {
      const { tx, rows } = fakeTx();

      await new AssignmentStaffLifecycleHooks(logger)[hook]({ tx, brandId, userId, actorId });

      expect(rows).toEqual([
        { brandId, event: ASSIGNMENT_EVENTS.accessChanged, payload: { userId } },
      ]);
    },
  );

  it('writes nothing on reactivation: the rotation reads the account state when it picks', async () => {
    const { tx, rows } = fakeTx();

    await new AssignmentStaffLifecycleHooks(logger).onStaffReactivated({
      tx,
      brandId,
      userId,
      actorId,
    });

    expect(rows).toEqual([]);
  });
});
