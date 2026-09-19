import type { DbTransaction } from '@helpdock/db';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertDepartmentDeletable,
  type DepartmentDeletionContext,
} from './department-deletion.js';
import { TicketingFailure } from './ticketing-failure.js';

// The hook never touches the transaction today, and M1-02's count will run
// inside the caller's; a placeholder keeps the signature honest without a
// database.
const context: DepartmentDeletionContext = {
  tx: {} as DbTransaction,
  brandId: '0199f4b2-6a91-7c27-9a1f-00000000000f',
  departmentId: '0199f4b2-6a91-7c27-9a1f-0000000000a1',
};

const refusalOf = async (promise: Promise<unknown>): Promise<TicketingFailure> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(TicketingFailure);
  return error as TicketingFailure;
};

describe('assertDepartmentDeletable', () => {
  it('allows a delete that leaves the brand a department to file tickets under', async () => {
    await expect(
      assertDepartmentDeletable(context, { remainingDepartments: 1 }),
    ).resolves.toBeUndefined();
  });

  it('refuses the last department, which would leave nowhere to file a ticket', async () => {
    const failure = await refusalOf(
      assertDepartmentDeletable(context, { remainingDepartments: 0 }),
    );

    expect(failure.reason).toBe('last-department');
    expect(failure.getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('refuses a department tickets still point at', async () => {
    const failure = await refusalOf(
      assertDepartmentDeletable(context, {
        remainingDepartments: 2,
        countTickets: () => Promise.resolve(3),
      }),
    );

    expect(failure.reason).toBe('department-in-use');
  });

  it('checks the last-department rule before counting tickets', async () => {
    let counted = false;

    const failure = await refusalOf(
      assertDepartmentDeletable(context, {
        remainingDepartments: 0,
        countTickets: () => {
          counted = true;
          return Promise.resolve(0);
        },
      }),
    );

    expect(failure.reason).toBe('last-department');
    expect(counted).toBe(false);
  });
});
