import type { DbTransaction, Ticket } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  ChannelReplyDeliveryHooks,
  type ReplyAssertion,
  ReplyDeliveryHook,
} from './reply-delivery.hook.js';

const tx = {} as DbTransaction;
const ticket = { id: 'ticket-1', channel: 'whatsapp' } as Ticket;
const assertion: ReplyAssertion = { brandId: 'brand-1', ticket, personAuthored: true };

/** A hook that notes it was asked, and throws `refusal` when it was given one. */
class AssertingHook extends ReplyDeliveryHook {
  constructor(
    readonly name: string,
    readonly asked: string[],
    readonly refusal?: Error,
  ) {
    super();
  }

  override async assertCanDeliver(): Promise<void> {
    this.asked.push(this.name);
    if (this.refusal !== undefined) {
      throw this.refusal;
    }
    await Promise.resolve();
  }
}

describe('ReplyDeliveryHook.assertCanDeliver', () => {
  it('allows every reply by default: a channel with no rule of its own refuses nothing', async () => {
    await expect(new ReplyDeliveryHook().assertCanDeliver(tx, assertion)).resolves.toBeUndefined();
  });
});

describe('ChannelReplyDeliveryHooks.assertCanDeliver', () => {
  it('asks every channel in turn before the reply is written', async () => {
    const asked: string[] = [];
    const hooks = new ChannelReplyDeliveryHooks([
      new AssertingHook('email', asked),
      new AssertingHook('meta', asked),
    ]);

    await hooks.assertCanDeliver(tx, assertion);

    expect(asked).toEqual(['email', 'meta']);
  });

  it('stops at the first refusal and lets it through unchanged', async () => {
    const asked: string[] = [];
    const refusal = new Error('the window is closed');
    const hooks = new ChannelReplyDeliveryHooks([
      new AssertingHook('meta', asked, refusal),
      new AssertingHook('telegram', asked),
    ]);

    await expect(hooks.assertCanDeliver(tx, assertion)).rejects.toBe(refusal);
    expect(asked).toEqual(['meta']);
  });
});
