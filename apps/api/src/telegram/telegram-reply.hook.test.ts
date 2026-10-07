import type { DbTransaction, Ticket } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  ChannelReplyDeliveryHooks,
  ReplyDeliveryHook,
  type StaffPublicReplyEvent,
} from '../tickets/reply-delivery.hook.js';
import type { OutboundTelegramService } from './outbound-telegram.service.js';
import { TelegramReplyHook } from './telegram-reply.hook.js';

const tx = {} as DbTransaction;

const eventOn = (channel: Ticket['channel']): StaffPublicReplyEvent => ({
  brandId: 'brand',
  ticket: { id: 'ticket', channel, contactId: 'contact', departmentId: 'dept' } as Ticket,
  messageId: 'message',
});

const recordingOutbound = () => {
  const queued: unknown[] = [];
  const outbound = {
    queueReply: async (_tx: DbTransaction, input: unknown) => {
      queued.push(input);
      return undefined;
    },
  } as unknown as OutboundTelegramService;
  return { queued, outbound };
};

describe('TelegramReplyHook', () => {
  it('queues a reply on a Telegram ticket to its chat', async () => {
    const { queued, outbound } = recordingOutbound();
    await new TelegramReplyHook(outbound).onStaffPublicReply(tx, eventOn('telegram'));

    expect(queued).toEqual([
      {
        brandId: 'brand',
        ticket: { id: 'ticket', channel: 'telegram', contactId: 'contact', departmentId: 'dept' },
        messageId: 'message',
      },
    ]);
  });

  it('leaves every other channel to its own hook', async () => {
    const { queued, outbound } = recordingOutbound();
    for (const channel of ['email', 'chat', 'form', 'manual', 'api'] as const) {
      await new TelegramReplyHook(outbound).onStaffPublicReply(tx, eventOn(channel));
    }
    expect(queued).toEqual([]);
  });
});

describe('ChannelReplyDeliveryHooks', () => {
  it('asks every channel’s hook, in order', async () => {
    const asked: string[] = [];
    const hook = (name: string) =>
      new (class extends ReplyDeliveryHook {
        override async onStaffPublicReply(): Promise<void> {
          asked.push(name);
          await Promise.resolve();
        }
      })();

    await new ChannelReplyDeliveryHooks([hook('email'), hook('telegram')]).onStaffPublicReply(
      tx,
      eventOn('telegram'),
    );
    expect(asked).toEqual(['email', 'telegram']);
  });
});
