import type { DbTransaction, MetaAccount, MetaConversation, Ticket } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import type { ReplyAssertion, StaffPublicReplyEvent } from '../tickets/reply-delivery.hook.js';
import { MetaFailure } from './meta-failure.js';
import { MetaReplyHook } from './meta-reply.hook.js';
import type { MetaReplyTarget, OutboundMetaService } from './outbound-meta.service.js';

const tx = {} as DbTransaction;
const customerWrote = new Date('2026-10-10T08:00:00.000Z');
const closesAt = new Date('2026-10-11T08:00:00.000Z');

const ticketOn = (channel: Ticket['channel']): Ticket =>
  ({ id: 'ticket', channel, contactId: 'contact', departmentId: 'dept' }) as Ticket;

const target = (window: MetaReplyTarget['window']): MetaReplyTarget => ({
  conversation: { lastInboundAt: customerWrote } as MetaConversation,
  account: { platform: 'whatsapp' } as MetaAccount,
  window,
});

const outboundWith = (answer: MetaReplyTarget | undefined) => {
  const asked: unknown[] = [];
  const queued: unknown[] = [];
  const outbound = {
    targetFor: async (_tx: DbTransaction, _ticket: unknown, personAuthored: boolean) => {
      asked.push(personAuthored);
      return answer;
    },
    queueReply: async (_tx: DbTransaction, input: unknown) => {
      queued.push(input);
      return undefined;
    },
  } as unknown as OutboundMetaService;

  return { asked, queued, outbound };
};

const assertion = (channel: Ticket['channel'], personAuthored = true): ReplyAssertion => ({
  brandId: 'brand',
  ticket: ticketOn(channel),
  personAuthored,
});

describe('MetaReplyHook.assertCanDeliver', () => {
  it.each(['whatsapp', 'messenger', 'instagram'] as const)(
    'refuses a person’s reply on a closed %s window with the details the composer needs',
    async (channel) => {
      const { outbound } = outboundWith(target({ state: 'closed', closedAt: closesAt }));

      const refusal = await new MetaReplyHook(outbound)
        .assertCanDeliver(tx, assertion(channel))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(refusal).toBeInstanceOf(MetaFailure);
      expect(refusal).toMatchObject({
        reason: 'reply-window-closed',
        details: {
          platform: 'whatsapp',
          anchorAt: '2026-10-10T08:00:00.000Z',
          closedAt: '2026-10-11T08:00:00.000Z',
        },
      });
      expect((refusal as MetaFailure).getStatus()).toBe(409);
    },
  );

  it('lets a reply through while the window is open, or open for a person only', async () => {
    for (const window of [
      { state: 'open', closesAt },
      { state: 'human_agent', closesAt },
    ] as const) {
      const { outbound } = outboundWith(target(window));
      await expect(
        new MetaReplyHook(outbound).assertCanDeliver(tx, assertion('messenger')),
      ).resolves.toBeUndefined();
    }
  });

  it('asks about the author it was told of', async () => {
    const { asked, outbound } = outboundWith(undefined);

    await new MetaReplyHook(outbound).assertCanDeliver(tx, assertion('whatsapp', false));

    expect(asked).toEqual([false]);
  });

  it('lets a reply through on a ticket no conversation belongs to', async () => {
    const { outbound } = outboundWith(undefined);

    await expect(
      new MetaReplyHook(outbound).assertCanDeliver(tx, assertion('whatsapp')),
    ).resolves.toBeUndefined();
  });

  it('leaves every other channel alone, without reading anything', async () => {
    const { asked, outbound } = outboundWith(target({ state: 'closed', closedAt: closesAt }));

    for (const channel of ['email', 'chat', 'form', 'telegram', 'manual', 'api'] as const) {
      await new MetaReplyHook(outbound).assertCanDeliver(tx, assertion(channel));
    }

    expect(asked).toEqual([]);
  });
});

describe('MetaReplyHook.onStaffPublicReply', () => {
  const eventOn = (
    channel: Ticket['channel'],
    personAuthored?: boolean,
  ): StaffPublicReplyEvent => ({
    brandId: 'brand',
    ticket: ticketOn(channel),
    messageId: 'message',
    ...(personAuthored === undefined ? {} : { personAuthored }),
  });

  it('queues a person’s reply on each Meta channel, saying a person wrote it', async () => {
    for (const channel of ['whatsapp', 'messenger', 'instagram'] as const) {
      const { queued, outbound } = outboundWith(undefined);

      await new MetaReplyHook(outbound).onStaffPublicReply(tx, eventOn(channel, true));

      expect(queued).toEqual([
        {
          brandId: 'brand',
          ticket: ticketOn(channel),
          messageId: 'message',
          personAuthored: true,
        },
      ]);
    }
  });

  it('takes a message that does not say a person wrote it for the assistant’s', async () => {
    const { queued, outbound } = outboundWith(undefined);

    await new MetaReplyHook(outbound).onStaffPublicReply(tx, eventOn('whatsapp'));

    expect(queued).toMatchObject([{ personAuthored: false }]);
  });

  it('leaves every other channel to its own hook', async () => {
    const { queued, outbound } = outboundWith(undefined);

    for (const channel of ['email', 'chat', 'form', 'telegram', 'manual', 'api'] as const) {
      await new MetaReplyHook(outbound).onStaffPublicReply(tx, eventOn(channel, true));
    }

    expect(queued).toEqual([]);
  });
});
