import type { DbTransaction, EmailDelivery } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { EmailRepository, type ReplyTarget } from './email.repository.js';

const delivery = {
  ticketId: 'ticket',
  createdAt: new Date('2026-11-10T14:10:00Z'),
} as EmailDelivery;
/** A target that already carries its chain needs no read; any query would throw. */
const noQueries = {} as DbTransaction;

const target = (values: Partial<ReplyTarget>): ReplyTarget => ({
  messageId: 'msg-1205@mail.example.com',
  references: [],
  senderName: null,
  sentAt: new Date('2026-11-10T12:05:00Z'),
  arrivedAt: new Date('2026-11-10T12:05:00Z'),
  text: '',
  ...values,
});

describe('EmailRepository.threadIds for a targeted reply', () => {
  const repository = new EmailRepository();

  it('replies to the target and files under its chain plus its id', async () => {
    const ids = await repository.threadIds(
      noQueries,
      delivery,
      target({ references: ['msg-1148@mail.example.com'] }),
    );

    expect(ids).toEqual({
      inReplyTo: 'msg-1205@mail.example.com',
      references: ['msg-1148@mail.example.com', 'msg-1205@mail.example.com'],
    });
  });

  it('does not repeat the target when its own chain already ends with it', async () => {
    const ids = await repository.threadIds(
      noQueries,
      delivery,
      target({ references: ['a@x.y', 'msg-1205@mail.example.com'] }),
    );

    expect(ids.references).toEqual(['a@x.y', 'msg-1205@mail.example.com']);
  });

  it('puts the target last even when it already stands inside its own chain', async () => {
    const ids = await repository.threadIds(
      noQueries,
      delivery,
      target({ references: ['a@x.y', 'msg-1205@mail.example.com', 'b@x.y'] }),
    );

    expect(ids.references).toEqual(['a@x.y', 'b@x.y', 'msg-1205@mail.example.com']);
  });

  it('keeps the newest twenty ids, the target last', async () => {
    const chain = Array.from({ length: 40 }, (_, index) => `m${String(index)}@x.y`);
    const ids = await repository.threadIds(noQueries, delivery, target({ references: chain }));

    expect(ids.references).toHaveLength(20);
    expect(ids.references.at(-1)).toBe('msg-1205@mail.example.com');
    expect(ids.references[0]).toBe('m21@x.y');
  });

  it('drops ids of the earlier thread that are not a single well-formed id', async () => {
    const chain = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [{ id: 'ok@x.y' }, { id: 'bad@x.y\r\nBcc: spy@evil.test' }],
            }),
          }),
        }),
      }),
    } as unknown as DbTransaction;

    const ids = await repository.threadIds(chain, delivery, target({}));

    expect(ids.references.join(' ')).not.toMatch(/Bcc|evil/);
    expect(ids.references).toContain('ok@x.y');
    expect(ids.references.at(-1)).toBe('msg-1205@mail.example.com');
  });
});
