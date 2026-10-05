import { describe, expect, it } from 'vitest';
import { outboxJobOrderingKeys } from './dispatcher.js';
import { createKeyedSerializer, outboxOrderingKeys } from './ordering.js';

const BRAND = '01a10000-0000-7000-8000-000000000001';

describe('outboxOrderingKeys', () => {
  it('orders an event by the ticket it names', () => {
    expect(
      outboxOrderingKeys({ brandId: BRAND, payload: { ticketId: 't1', kind: 'public' } }),
    ).toEqual(['ticket:t1']);
  });

  it('orders an event that names several tickets by all of them, sorted, once each', () => {
    expect(
      outboxOrderingKeys({
        brandId: BRAND,
        payload: { primaryTicketId: 't2', sourceTicketId: 't1', ticketIds: ['t3', 't1'] },
      }),
    ).toEqual(['ticket:t1', 'ticket:t2', 'ticket:t3']);
  });

  it('orders an event about no ticket by its brand, as all of them used to be', () => {
    expect(outboxOrderingKeys({ brandId: BRAND, payload: { key: 'smtp.host' } })).toEqual([
      `brand:${BRAND}`,
    ]);
  });

  it('ignores a ticket field that is not a string', () => {
    expect(
      outboxOrderingKeys({ brandId: BRAND, payload: { ticketId: 7, ticketIds: [null] } }),
    ).toEqual([`brand:${BRAND}`]);
  });
});

describe('outboxJobOrderingKeys', () => {
  it('reads the keys off raw job data, and gives nothing for data that will not parse', () => {
    expect(
      outboxJobOrderingKeys({
        outboxId: '01a10000-0000-7000-8000-000000000002',
        brandId: BRAND,
        event: 'ticket.updated',
        payload: { ticketId: 't1' },
      }),
    ).toEqual(['ticket:t1']);
    expect(outboxJobOrderingKeys({ nonsense: true })).toEqual([]);
  });
});

describe('createKeyedSerializer', () => {
  const deferred = () => {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  it('runs tasks that share a key one after another, in call order', async () => {
    const serializer = createKeyedSerializer();
    const gate = deferred();
    const order: string[] = [];

    const first = serializer.run(['ticket:a'], async () => {
      await gate.promise;
      order.push('first');
    });
    const second = serializer.run(['ticket:a'], async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('runs tasks with no key in common side by side', async () => {
    const serializer = createKeyedSerializer();
    const gate = deferred();
    const order: string[] = [];

    const held = serializer.run(['ticket:a'], async () => {
      await gate.promise;
      order.push('a');
    });
    await serializer.run(['ticket:b'], async () => {
      order.push('b');
    });

    expect(order).toEqual(['b']);
    gate.resolve();
    await held;
  });

  it('waits for every key a task names', async () => {
    const serializer = createKeyedSerializer();
    const gate = deferred();
    const order: string[] = [];

    const onB = serializer.run(['ticket:b'], async () => {
      await gate.promise;
      order.push('b');
    });
    const both = serializer.run(['ticket:a', 'ticket:b'], async () => {
      order.push('a+b');
    });

    gate.resolve();
    await Promise.all([onB, both]);
    expect(order).toEqual(['b', 'a+b']);
  });

  it('lets the next task run after one fails, and passes the failure to its own caller', async () => {
    const serializer = createKeyedSerializer();

    const failing = serializer.run(['ticket:a'], () => Promise.reject(new Error('boom')));
    const next = serializer.run(['ticket:a'], () => Promise.resolve('ran'));

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
  });

  it('forgets a key once nothing is queued on it', async () => {
    const serializer = createKeyedSerializer();

    await serializer.run(['ticket:a', 'ticket:b'], () => Promise.resolve());

    expect(serializer.pending).toBe(0);
  });
});
