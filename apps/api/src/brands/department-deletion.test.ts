import type { DbTransaction } from '@helpdock/db';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertDepartmentDeletable,
  type DepartmentDeletionContext,
  ticketsInDepartment,
} from './department-deletion.js';
import { TicketingFailure } from './ticketing-failure.js';

const BRAND = '0199f4b2-6a91-7c27-9a1f-00000000000f';
const DEPARTMENT = '0199f4b2-6a91-7c27-9a1f-0000000000a1';

/**
 * A transaction that answers one `select … from tickets` with the rows it was
 * given. The real query is proved against Postgres in
 * `brands.integration.test.ts`; what is worth checking here is that the hook
 * reads the total it is handed, including an empty result.
 */
const txReturning = (rows: { total: number }[]): DbTransaction =>
  ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  }) as unknown as DbTransaction;

const contextWith = (rows: { total: number }[]): DepartmentDeletionContext => ({
  tx: txReturning(rows),
  brandId: BRAND,
  departmentId: DEPARTMENT,
});

const context = contextWith([{ total: 0 }]);

const refusalOf = async (promise: Promise<unknown>): Promise<TicketingFailure> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(TicketingFailure);
  return error as TicketingFailure;
};

describe('ticketsInDepartment', () => {
  it('reads the count the query returned', async () => {
    expect(await ticketsInDepartment(contextWith([{ total: 7 }]))).toBe(7);
  });

  it('treats an empty result as no tickets rather than as undefined', async () => {
    expect(await ticketsInDepartment(contextWith([]))).toBe(0);
  });
});

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
      assertDepartmentDeletable(contextWith([{ total: 3 }]), { remainingDepartments: 2 }),
    );

    expect(failure.reason).toBe('department-in-use');
    expect(failure.getStatus()).toBe(HttpStatus.CONFLICT);
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
