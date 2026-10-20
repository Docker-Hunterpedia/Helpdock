import { describe, expect, it } from 'vitest';
import { type BatchItem, groupBatch } from './email-batch-content.js';

let sequence = 0;
const item = (overrides: Partial<BatchItem> = {}): BatchItem => {
  sequence += 1;
  return {
    id: `n-${sequence}`,
    kind: 'replied',
    ticketId: 'ticket-1042',
    reference: 'HD-1042',
    subject: 'Refund not received after 10 days',
    contactName: 'Mona Khalil',
    actorName: null,
    detail: {},
    createdAt: new Date(Date.UTC(2026, 9, 20, 14, 52 + sequence)),
    bulkOperationId: null,
    ...overrides,
  };
};

describe('groupBatch (M14-10)', () => {
  it('says nothing about nothing', () => {
    expect(groupBatch([], 'batch')).toBeNull();
  });

  it('counts per kind in the preference table’s order, since the oldest row', () => {
    const oldest = new Date('2026-10-20T14:52:00.000Z');
    const first = item({
      kind: 'assigned',
      ticketId: 't-1',
      reference: 'HD-1',
      actorName: 'Omar',
      createdAt: oldest,
    });
    const content = groupBatch(
      [item(), item(), first, item({ kind: 'mentioned', actorName: 'Dana' })],
      'batch',
    );

    expect(content?.total).toBe(4);
    expect(content?.counts).toEqual([
      ['assigned', 1],
      ['replied', 2],
      ['mentioned', 1],
    ]);
    expect(content?.since).toEqual(oldest);
  });

  it('lists mentions, breaches and escalations under Needs you now, one line per ticket', () => {
    const content = groupBatch(
      [
        item({
          kind: 'sla_breached',
          ticketId: 't-1038',
          reference: 'HD-1038',
          detail: { clock: 'first_response' },
        }),
        item({ kind: 'mentioned', ticketId: 't-1029', reference: 'HD-1029', actorName: 'Dana' }),
        item({ kind: 'replied' }),
      ],
      'batch',
    );

    expect(content?.needsYouNow.map((line) => line.type === 'ticket' && line.reference)).toEqual([
      'HD-1029',
      'HD-1038',
    ]);
    expect(content?.tickets).toHaveLength(1);
  });

  it('folds a ticket’s rows per kind: "Mona replied twice", assigned by Omar', () => {
    const content = groupBatch(
      [
        item({ kind: 'assigned', actorName: 'Omar', detail: { assignedBy: 'person' } }),
        item(),
        item(),
      ],
      'batch',
    );

    expect(content?.tickets).toEqual([
      {
        type: 'ticket',
        ticketId: 'ticket-1042',
        reference: 'HD-1042',
        subject: 'Refund not received after 10 days',
        contactName: 'Mona Khalil',
        events: [
          { kind: 'replied', count: 2, actors: [], detail: {} },
          {
            kind: 'assigned',
            count: 1,
            actors: [{ name: 'Omar' }],
            detail: { assignedBy: 'person' },
          },
        ],
      },
    ]);
  });

  it('names the rotation and rules rather than a person who did not assign', () => {
    const content = groupBatch(
      [item({ kind: 'assigned', actorName: 'Ada', detail: { assignedBy: 'round_robin' } })],
      'batch',
    );
    const [line] = content?.tickets ?? [];

    expect(line?.type === 'ticket' && line.events[0]?.actors).toEqual([
      { automatic: 'round_robin' },
    ]);
  });

  it('folds one bulk operation’s assignments into one line once M14-03 records it', () => {
    const bulk = (n: number) =>
      item({
        kind: 'assigned',
        ticketId: `t-${n}`,
        reference: `HD-${n}`,
        actorName: 'Omar',
        detail: { assignedBy: 'person' },
        bulkOperationId: 'bulk-1',
      });
    const content = groupBatch([bulk(1041), bulk(1035), bulk(1033), item()], 'batch');

    expect(content?.tickets[0]).toEqual({
      type: 'bulk',
      kind: 'assigned',
      actors: [{ name: 'Omar' }],
      references: ['HD-1033', 'HD-1035', 'HD-1041'],
    });
    expect(content?.tickets[1]).toMatchObject({ type: 'ticket', reference: 'HD-1042' });
  });

  it('leaves a bulk operation that touched one ticket as an ordinary line', () => {
    const content = groupBatch([item({ kind: 'assigned', bulkOperationId: 'bulk-1' })], 'batch');

    expect(content?.tickets[0]?.type).toBe('ticket');
  });

  it('rolls a digest up per kind across tickets: "7 tickets assigned to you"', () => {
    const assigned = (n: number, by: 'person' | 'round_robin') =>
      item({
        kind: 'assigned',
        ticketId: `t-${n}`,
        reference: `HD-${n}`,
        actorName: 'Omar',
        detail: { assignedBy: by },
      });
    const content = groupBatch(
      [assigned(1, 'person'), assigned(2, 'round_robin'), assigned(3, 'person'), item()],
      'digest',
    );

    expect(content?.tickets[0]).toEqual({
      type: 'rollup',
      kind: 'assigned',
      ticketCount: 3,
      actors: [{ name: 'Omar' }, { automatic: 'round_robin' }],
      references: ['HD-3', 'HD-2', 'HD-1'],
    });
    // A kind on one ticket stays a ticket line.
    expect(content?.tickets[1]).toMatchObject({ type: 'ticket', reference: 'HD-1042' });
  });
});
