import { silentLogger } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import { FakeStorage, fakeTx, type OutboxRow } from '../testing/media.js';
import {
  attachmentObjectKeys,
  createObjectPurgeHandler,
  enqueueObjectPurge,
  ForeignObjectKeyError,
  OBJECT_PURGE_CHUNK,
  OBJECT_PURGE_EVENT,
  type PurgeableAttachment,
} from './object-purge.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const OTHER_BRAND = '01937f5e-7e53-7000-8000-00000000000f';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const ATTACHMENT = '01937f5e-7e53-7000-8000-00000000000c';
const OUTBOX = '01937f5e-7e53-7000-8000-0000000000e1';

const attachment = (id = ATTACHMENT): PurgeableAttachment => ({
  id,
  brandId: BRAND,
  ticketId: TICKET,
  s3Key: `brands/${BRAND}/tickets/${TICKET}/${id}/original`,
});

const context = (keys: readonly string[], brandId = BRAND) => ({
  outboxId: OUTBOX,
  brandId,
  event: OBJECT_PURGE_EVENT,
  payload: { keys },
  tx: fakeTx([]),
  log: silentLogger,
});

describe('attachmentObjectKeys', () => {
  it('names the upload and every variant the pipeline can write, once each', () => {
    const keys = attachmentObjectKeys(attachment());
    const prefix = `brands/${BRAND}/tickets/${TICKET}/${ATTACHMENT}/`;

    expect(keys).toEqual(
      ['original', 'webp', 'thumb320', 'thumb960', 'poster', 'opus'].map((v) => `${prefix}${v}`),
    );
  });
});

describe('enqueueObjectPurge', () => {
  it('writes the keys through the caller’s transaction, so a rolled-back purge deletes nothing', async () => {
    const written: OutboxRow[] = [];

    const queued = await enqueueObjectPurge(fakeTx(written), BRAND, [attachment()]);

    expect(queued).toBe(6);
    expect(written).toHaveLength(1);
    expect(written[0]?.event).toBe(OBJECT_PURGE_EVENT);
    expect(written[0]?.brandId).toBe(BRAND);
  });

  it('splits a large purge into rows of at most one chunk of keys', async () => {
    const written: OutboxRow[] = [];
    const many = Array.from({ length: 40 }, (_, index) =>
      attachment(`01937f5e-7e53-7000-8000-${String(index).padStart(12, '0')}`),
    );

    await enqueueObjectPurge(fakeTx(written), BRAND, many);

    expect(written).toHaveLength(Math.ceil((40 * 6) / OBJECT_PURGE_CHUNK));
    expect(written.flatMap((row) => row.payload.keys as string[])).toHaveLength(240);
  });

  it('writes nothing when nothing had attachments', async () => {
    const written: OutboxRow[] = [];

    expect(await enqueueObjectPurge(fakeTx(written), BRAND, [])).toBe(0);
    expect(written).toEqual([]);
  });
});

describe('the purge handler', () => {
  it('deletes every key the row names', async () => {
    const storage = new FakeStorage('/nonexistent');
    const keys = attachmentObjectKeys(attachment());

    await createObjectPurgeHandler(storage)(context(keys));

    expect(storage.removed).toEqual(keys);
  });

  it('deletes nothing at all when one key is outside the brand’s prefix', async () => {
    const storage = new FakeStorage('/nonexistent');
    const keys = [
      ...attachmentObjectKeys(attachment()),
      `brands/${OTHER_BRAND}/tickets/x/y/original`,
    ];

    await expect(createObjectPurgeHandler(storage)(context(keys))).rejects.toBeInstanceOf(
      ForeignObjectKeyError,
    );
    expect(storage.removed).toEqual([]);
  });

  it('refuses a payload with no keys rather than succeeding at nothing', async () => {
    await expect(
      createObjectPurgeHandler(new FakeStorage('/nonexistent'))(context([])),
    ).rejects.toThrow();
  });
});
