import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { writeSystemLine } from './meta-thread.js';

/**
 * `ticketOfMessage` is a pair of queries and is proved against Postgres in
 * `meta-messenger.integration.test.ts`; what a line is written as is here.
 */

const account = { id: 'acc-1', brandId: 'brand-1', platform: 'messenger' } as const;
const thread = { ticketId: 'ticket-1', departmentId: 'dept-1' };
const tx = {} as DbTransaction;

const tickets = () => ({
  insertMessage: vi.fn(async () => ({}) as never),
  nextSeq: vi.fn(async () => 7),
});

describe('writeSystemLine', () => {
  it('writes a system message as the account, next in the ticket’s sequence', async () => {
    const repository = tickets();

    await writeSystemLine(repository, tx, account, thread, { text: 'Seen.', key: 'edit:m1:2' });

    expect(repository.nextSeq).toHaveBeenCalledWith(tx, 'ticket-1');
    expect(repository.insertMessage).toHaveBeenCalledWith(tx, {
      brandId: 'brand-1',
      ticketId: 'ticket-1',
      departmentId: 'dept-1',
      seq: 7,
      kind: 'system',
      authorType: 'system',
      authorId: 'meta:messenger:acc-1',
      bodyHtml: '<p>Seen.</p>',
      bodyText: 'Seen.',
      channel: 'messenger',
      externalMessageId: 'edit:m1:2',
    });
  });

  it('escapes a customer’s words in the HTML and keeps them as typed in the text', async () => {
    const repository = tickets();

    await writeSystemLine(repository, tx, account, thread, {
      text: 'It now reads: <img src=x onerror=alert(1)> & "more"',
      key: null,
    });

    expect(repository.insertMessage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        bodyHtml: '<p>It now reads: &lt;img src=x onerror=alert(1)&gt; &amp; &quot;more&quot;</p>',
        bodyText: 'It now reads: <img src=x onerror=alert(1)> & "more"',
      }),
    );
  });

  it('leaves the dedupe column empty when the event has nothing to key on', async () => {
    const repository = tickets();

    await writeSystemLine(repository, tx, account, thread, { text: 'Hi', key: null });

    const [, values] = repository.insertMessage.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(values).not.toHaveProperty('externalMessageId');
  });
});
