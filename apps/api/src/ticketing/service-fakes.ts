import type { DbTransaction } from '@helpdock/db';
import type { TicketingActor, TicketingContext } from './ticketing-context.js';

/**
 * What the three service suites need in place of a database: a transaction that
 * records the audit rows written through it, and a context to hand the writes.
 *
 * The repositories are faked per suite, because each one's shape is the thing
 * that suite is about. What is shared is only this: an `insert(...).values(...)`
 * that remembers, which is the whole of `writeTicketingAudit`'s contract.
 *
 * It is a source file rather than a `*.test.ts` because three test files import
 * it, and Vitest would otherwise run it as an empty suite.
 */

export interface AuditRow {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly meta: Record<string, unknown>;
}

export interface FakeTransaction {
  readonly tx: DbTransaction;
  /** Every row written through `writeTicketingAudit`, in order. */
  readonly audit: AuditRow[];
}

/**
 * A `select(...).from(...).where(...).orderBy(...)` chain that answers `rows`.
 *
 * `orderBy` is the terminal step because that is where `readFieldRules` ends —
 * the one read these suites drive through a transaction. A thenable object
 * would serve every shape, but an object with a `then` is a trap for the next
 * `await` that touches it, so the chain ends in a real promise instead.
 */
const selectChain = (rows: readonly unknown[]) => {
  const chain: Record<string, unknown> = { orderBy: () => Promise.resolve(rows) };
  for (const step of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[step] = () => chain;
  }

  return chain;
};

export const fakeTransaction = (
  /** What a `select` answers. Empty means "this brand defines no custom fields". */
  selected: readonly unknown[] = [],
): FakeTransaction => {
  const audit: AuditRow[] = [];
  const tx = {
    insert: () => ({
      values: (row: AuditRow) => {
        audit.push(row);

        return Promise.resolve();
      },
    }),
    select: () => selectChain(selected),
    // biome-ignore lint/suspicious/noExplicitAny: a Drizzle transaction has ~40 methods and these suites use three.
  } as any as DbTransaction;

  return { tx, audit };
};

export const ADMIN: TicketingActor = {
  userId: '01937f5e-7e53-7000-8000-000000000001',
  role: 'admin',
  departmentIds: 'all',
};

export const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';

export const contextFor = (tx: DbTransaction, actor: TicketingActor = ADMIN): TicketingContext => ({
  tx,
  brandId: BRAND,
  actor,
});
