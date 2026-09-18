import { describe, expect, it } from 'vitest';
import { outboxEntrySchema } from './outbox.js';

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
