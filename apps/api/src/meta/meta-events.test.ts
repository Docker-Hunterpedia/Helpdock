import type { DbTransaction } from '@helpdock/db';
import {
  type MetaMediaFetchPayload,
  type MetaProfileFetchPayload,
  type MetaSendPayload,
  outboxEvents,
  silentLogger,
} from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import {
  createMetaMediaEventHandler,
  createMetaProfileEventHandler,
  createMetaReplyEventHandler,
  enqueueMetaAccountChanged,
  enqueueMetaMedia,
  enqueueMetaProfile,
  enqueueMetaReply,
  META_EVENTS,
  metaMediaFetchJobId,
  metaProfileFetchJobId,
  metaSendJobId,
  registerMetaEventHandlers,
} from './meta-events.js';

const brandId = '01924f00-0000-7000-8000-0000000000aa';
const outboxId = '01924f00-0000-7000-8000-0000000000bb';
const deliveryId = '01924f00-0000-7000-8000-0000000000cc';
const accountId = '01924f00-0000-7000-8000-0000000000dd';
const attachmentId = '01924f00-0000-7000-8000-0000000000ee';
const conversationId = '01924f00-0000-7000-8000-0000000000ef';

const ref = {
  kind: 'whatsapp_media',
  type: 'image',
  mediaId: '1166846181421424',
  mimeType: 'image/jpeg',
  sha256: 'Zm9v',
} as const;

const capture = <T>() => {
  const added: { jobId: string; payload: T }[] = [];
  return { added, queue: { add: async (input: (typeof added)[number]) => void added.push(input) } };
};

const context = (event: string, payload: Record<string, unknown>) => ({
  outboxId,
  brandId,
  event,
  payload,
  tx: {} as DbTransaction,
  log: silentLogger,
});

/** A transaction that records what would have been written to the outbox. */
const recordingTx = () => {
  const rows: { brandId: string; event: string; payload: unknown }[] = [];
  const tx = {
    insert: () => ({
      values: (row: (typeof rows)[number]) => {
        rows.push(row);
        return { returning: async () => [{ id: outboxId }] };
      },
    }),
  } as unknown as DbTransaction;
  return { rows, tx };
};

describe('the Meta outbox events', () => {
  it('names the events of the contract', () => {
    expect(META_EVENTS).toEqual({
      reply: 'meta.reply',
      media: 'meta.media',
      profile: 'meta.profile',
      accountChanged: 'meta_account.changed',
    });
  });

  it('writes a reply, a media file and an account change as outbox rows of their own', async () => {
    const { rows, tx } = recordingTx();

    await enqueueMetaReply(tx, brandId, deliveryId);
    await enqueueMetaMedia(tx, brandId, { attachmentId, accountId, ref });
    await enqueueMetaAccountChanged(tx, brandId, accountId);

    expect(rows).toEqual([
      { brandId, event: 'meta.reply', payload: { deliveryId } },
      { brandId, event: 'meta.media', payload: { attachmentId, accountId, ref } },
      { brandId, event: 'meta_account.changed', payload: { accountId } },
    ]);
  });

  it('writes a profile lookup with the conversation and no brand, which the row has', async () => {
    const { rows, tx } = recordingTx();

    await enqueueMetaProfile(tx, brandId, { conversationId, accountId, platform: 'instagram' });

    expect(rows).toEqual([
      {
        brandId,
        event: 'meta.profile',
        payload: { conversationId, accountId, platform: 'instagram' },
      },
    ]);
  });

  it('refuses to write an event whose payload is not what its consumer reads', async () => {
    const { rows, tx } = recordingTx();

    await expect(enqueueMetaReply(tx, brandId, 'not-a-uuid')).rejects.toThrow();
    await expect(
      enqueueMetaMedia(tx, brandId, {
        attachmentId,
        accountId,
        ref: { kind: 'cdn_url', url: 'ftp://example.com/x', type: 'image' },
      }),
    ).rejects.toThrow();
    await expect(
      enqueueMetaProfile(tx, brandId, { conversationId, accountId, platform: 'whatsapp' } as never),
    ).rejects.toThrow();
    expect(rows).toEqual([]);
  });

  it('turns a reply into one meta.send job under the outbox row’s id', async () => {
    const { added, queue } = capture<MetaSendPayload>();
    await createMetaReplyEventHandler(queue)(context(META_EVENTS.reply, { deliveryId }));

    expect(added).toEqual([
      { jobId: `meta.send.${outboxId}`, payload: { kind: 'reply', brandId, deliveryId } },
    ]);
  });

  it('turns a media event into one meta.media_fetch job under the outbox row’s id', async () => {
    const { added, queue } = capture<MetaMediaFetchPayload>();
    await createMetaMediaEventHandler(queue)(
      context(META_EVENTS.media, { attachmentId, accountId, ref }),
    );

    expect(added).toEqual([
      { jobId: `meta.media_fetch.${outboxId}`, payload: { brandId, attachmentId, accountId, ref } },
    ]);
  });

  it('turns a profile event into one meta.profile_fetch job under the outbox row’s id', async () => {
    const { added, queue } = capture<MetaProfileFetchPayload>();
    await createMetaProfileEventHandler(queue)(
      context(META_EVENTS.profile, { conversationId, accountId, platform: 'messenger' }),
    );

    expect(added).toEqual([
      {
        jobId: `meta.profile_fetch.${outboxId}`,
        payload: { brandId, conversationId, accountId, platform: 'messenger' },
      },
    ]);
  });

  it('keeps colons out of job ids, which BullMQ refuses', () => {
    expect(metaSendJobId(outboxId)).not.toContain(':');
    expect(metaMediaFetchJobId(outboxId)).not.toContain(':');
    expect(metaProfileFetchJobId(outboxId)).not.toContain(':');
  });

  it('refuses a payload it cannot trust, so the event lands in the failed set', async () => {
    const send = capture<MetaSendPayload>();
    const media = capture<MetaMediaFetchPayload>();
    const profile = capture<MetaProfileFetchPayload>();

    await expect(
      createMetaReplyEventHandler(send.queue)(context(META_EVENTS.reply, { deliveryId: 'x' })),
    ).rejects.toThrow();
    await expect(
      createMetaMediaEventHandler(media.queue)(
        context(META_EVENTS.media, { attachmentId, accountId, ref: { kind: 'unknown' } }),
      ),
    ).rejects.toThrow();
    await expect(
      createMetaProfileEventHandler(profile.queue)(
        context(META_EVENTS.profile, { conversationId, accountId, platform: 'whatsapp' }),
      ),
    ).rejects.toThrow();
    expect(send.added).toEqual([]);
    expect(media.added).toEqual([]);
    expect(profile.added).toEqual([]);
  });

  it('registers all four consumers, once: a second call is refused by the dispatcher', () => {
    const noop = () => Promise.resolve();
    const consumers = {
      sendQueue: { add: noop },
      mediaQueue: { add: noop },
      profileQueue: { add: noop },
      accountChanged: noop,
    };

    registerMetaEventHandlers(consumers);

    expect(outboxEvents.events).toEqual(
      expect.arrayContaining(['meta.reply', 'meta.media', 'meta.profile', 'meta_account.changed']),
    );
    expect(() => registerMetaEventHandlers(consumers)).toThrow();
  });
});
