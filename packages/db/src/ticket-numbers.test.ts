import { describe, expect, it } from 'vitest';
import type { DbTransaction } from './client.js';
import { nextMessageSeq, nextTicketNumber, TicketNumberError } from './ticket-numbers.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';

/**
 * A stub transaction that records the statements it was asked to run, so the
 * *order* of them can be asserted. Order is the whole correctness argument for
 * `nextMessageSeq` — the lock has to be taken before the maximum is read — and
 * it is the one thing a real database cannot be asked about directly.
 */
const recordingTx = (results: readonly unknown[][]) => {
  const statements: string[] = [];
  let call = 0;

  const tx = {
    execute: (query: { queryChunks?: unknown[] } & Record<string, unknown>) => {
      statements.push(JSON.stringify(query.queryChunks ?? query));
      const result = results[call] ?? [];
      call += 1;
      return Promise.resolve(result);
    },
  } as unknown as DbTransaction;

  return { tx, statements };
};

describe('nextTicketNumber', () => {
  it('draws from the brand’s own sequence', async () => {
    const { tx, statements } = recordingTx([[{ number: '1042' }]]);

    expect(await nextTicketNumber(tx, BRAND)).toBe(1042);
    expect(statements[0]).toContain('nextval');
    // The name is bound as a parameter cast to regclass, never pasted in.
    expect(statements[0]).toContain(`brand_ticket_seq_${BRAND.replaceAll('-', '')}`);
  });

  it('refuses a brand id that is not a uuid before anything reaches SQL', async () => {
    const { tx, statements } = recordingTx([]);

    await expect(nextTicketNumber(tx, "'; drop table tickets --")).rejects.toThrow(TypeError);
    expect(statements).toEqual([]);
  });

  it('raises rather than inventing a number when the sequence answers nothing', async () => {
    const { tx } = recordingTx([[]]);

    await expect(nextTicketNumber(tx, BRAND)).rejects.toThrow(TicketNumberError);
  });
});

describe('nextMessageSeq', () => {
  it('locks the ticket row before reading the maximum', async () => {
    // Statement *order* is the whole correctness argument, and it is the one
    // thing a real database cannot be asked about directly: twenty replies
    // arriving at once queue on that lock, one transaction at a time, so no two
    // of them read the same maximum. What the counter actually produces under
    // contention is proved against Postgres in
    // `apps/api/src/tickets/tickets.integration.test.ts`.
    const { tx, statements } = recordingTx([[{ id: TICKET }], [{ seq: 4 }]]);

    await nextMessageSeq(tx, TICKET);

    expect(statements[0]).toContain('FOR UPDATE');
    expect(statements[1]).toContain('max(seq)');
  });

  it('refuses a ticket the transaction cannot see, rather than handing back 1', async () => {
    // Row-level security is what decides whether the ticket exists for this
    // principal; a silent 1 would collide with the real thread's first message.
    const { tx, statements } = recordingTx([[]]);

    await expect(nextMessageSeq(tx, TICKET)).rejects.toThrow(TicketNumberError);
    expect(statements).toHaveLength(1);
  });
});
