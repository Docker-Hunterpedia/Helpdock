import { describe, expect, it } from 'vitest';
import { deliverAfter, deliveryDelayMs, outboxEntrySchema } from './outbox.js';

const brandId = '01924f00-0000-7000-8000-0000000000aa';

describe('outboxEntrySchema', () => {
  it('accepts a dotted event with a JSON payload', () => {
    const entry = outboxEntrySchema.parse({
      brandId,
      event: 'ticket.replied',
      payload: { ticketId: 7, notify: true },
    });

    expect(entry.event).toBe('ticket.replied');
  });

  it.each([
    'replied',
    'Ticket.replied',
    'ticket.',
    '.replied',
    'ticket..replied',
    'ticket-replied',
  ])('refuses %s as an event name', (event) => {
    expect(outboxEntrySchema.safeParse({ brandId, event, payload: {} }).success).toBe(false);
  });

  it('accepts nested dotted segments', () => {
    expect(
      outboxEntrySchema.safeParse({ brandId, event: 'knowledge.source.synced', payload: {} })
        .success,
    ).toBe(true);
  });

  it('refuses a brand that is not a uuid', () => {
    expect(
      outboxEntrySchema.safeParse({ brandId: 'acme', event: 'ticket.replied', payload: {} })
        .success,
    ).toBe(false);
  });

  it('refuses a payload that is not an object, because the column is jsonb', () => {
    expect(
      outboxEntrySchema.safeParse({ brandId, event: 'ticket.replied', payload: 'replied' }).success,
    ).toBe(false);
  });
});

describe('deliverAfter', () => {
  const at = new Date('2026-10-20T12:01:00.000Z');

  it('sets the reserved key without touching the rest of the payload', () => {
    expect(deliverAfter({ ticketId: 'a' }, at)).toEqual({
      ticketId: 'a',
      deliverAfter: '2026-10-20T12:01:00.000Z',
    });
  });

  it('is the delay the relay holds the job back by', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');

    expect(deliveryDelayMs(deliverAfter({}, at), now)).toBe(60_000);
  });

  it.each([
    ['a payload without the key', {}],
    ['an instant that has passed', { deliverAfter: '2026-10-20T11:00:00.000Z' }],
    ['a value that is not an instant', { deliverAfter: 'soon' }],
    ['a value that is not text', { deliverAfter: 5 }],
  ])('is zero for %s', (_name, payload) => {
    expect(deliveryDelayMs(payload, new Date('2026-10-20T12:00:00.000Z'))).toBe(0);
  });
});
