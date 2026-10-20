import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { enqueueWebhookEvent } from './enqueue-webhook-event.js';

const ID = '0192a000-0000-7000-8000-000000000001';
const recorder = () => {
  const stored: Record<string, unknown>[] = [];
  const insert = vi.fn(() => ({
    values: (entry: Record<string, unknown>) => {
      stored.push(entry);
      return { returning: async () => [{ id: ID }] };
    },
  }));
  return { stored, insert, tx: { insert } as unknown as DbTransaction };
};

describe('transactional webhook references', () => {
  it('never puts a supplied body into a message outbox entry', async () => {
    const { tx, stored } = recorder();
    const reference = {
      ticketId: ID,
      messageId: ID,
      departmentId: ID,
      bodyText: 'Internal secret',
    };
    await enqueueWebhookEvent(tx, ID, 'message.created', reference);
    expect(stored).toEqual([
      {
        brandId: ID,
        event: 'message.created',
        payload: { ticketId: ID, messageId: ID, departmentId: ID },
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain('Internal secret');
  });
  it('refuses an unscoped ticket event before writing', async () => {
    const { tx, insert } = recorder();
    expect(() =>
      enqueueWebhookEvent(tx, ID, 'message.created', {
        ticketId: ID,
        messageId: ID,
        departmentId: '',
      }),
    ).toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
