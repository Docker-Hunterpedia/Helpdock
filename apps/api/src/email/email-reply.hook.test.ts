import type { Ticket } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { recordingTx } from '../testing/email-doubles.js';
import { BRAND, MESSAGE, TICKET } from '../testing/email-fixtures.js';
import { EmailReplyHook } from './email-reply.hook.js';
import type { OutboundEmailService, QueueReplyInput } from './outbound-email.service.js';

const hookWith = () => {
  const queued: QueueReplyInput[] = [];
  const outbound = {
    queueReply: async (_tx: unknown, input: QueueReplyInput) => {
      queued.push(input);
      return undefined;
    },
  } as unknown as OutboundEmailService;
  return { hook: new EmailReplyHook(outbound), queued };
};

const ticket = (channel: Ticket['channel']) => ({ id: TICKET, channel }) as Ticket;

describe('EmailReplyHook', () => {
  it('queues a reply on a ticket that answers by email, with the composer sender', async () => {
    const { hook, queued } = hookWith();

    await hook.onStaffPublicReply(recordingTx().tx, {
      brandId: BRAND,
      ticket: ticket('email'),
      messageId: MESSAGE,
      emailFrom: 'default',
    });

    expect(queued).toEqual([
      { brandId: BRAND, ticketId: TICKET, messageId: MESSAGE, senderKey: 'default' },
    ]);
  });

  it('leaves a chat or Telegram ticket to its own channel', async () => {
    const { hook, queued } = hookWith();

    for (const channel of ['chat', 'telegram', 'api'] as const) {
      await hook.onStaffPublicReply(recordingTx().tx, {
        brandId: BRAND,
        ticket: ticket(channel),
        messageId: MESSAGE,
      });
    }

    expect(queued).toEqual([]);
  });
});
