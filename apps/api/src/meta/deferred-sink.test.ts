import type { NewAttachment } from '@helpdock/db';
import { type ContentPolicy, DEFAULT_CONTENT_POLICY, type MetaFileRef } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { MediaRepository } from '../media/media.repository.js';
import { fakeTx, type OutboxRow, policyWith } from '../testing/media.js';
import { DeferredAttachmentSink, declaredFile, metaFileName } from './deferred-sink.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const DEPARTMENT = '01937f5e-7e53-7000-8000-00000000000d';
const MESSAGE = '01937f5e-7e53-7000-8000-00000000000e';
const CONTACT = '01937f5e-7e53-7000-8000-00000000000f';
const ACCOUNT = '01937f5e-7e53-7000-8000-000000000010';
const ids = [
  '01937f5e-7e53-7000-8000-0000000000a1',
  '01937f5e-7e53-7000-8000-0000000000a2',
  '01937f5e-7e53-7000-8000-0000000000a3',
];

const whatsapp = (
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker',
  mimeType: string,
  extra: { filename?: string; voice?: boolean } = {},
): MetaFileRef => ({
  kind: 'whatsapp_media',
  type,
  mediaId: '1479537139650973',
  mimeType,
  sha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
  ...extra,
});

const cdn = (type: string): MetaFileRef => ({
  kind: 'cdn_url',
  url: 'https://scontent.xx.fbcdn.net/v/t1.15752-9/12345_n.jpg?_nc_cat=1&oh=signature',
  type,
});

const run = async (
  refs: readonly MetaFileRef[],
  options: {
    policy?: ContentPolicy;
    refusal?: 'unreadable';
  } = {},
) => {
  const rows: NewAttachment[] = [];
  const outbox: OutboxRow[] = [];
  const media = {
    contentPolicy: async () => options.policy ?? DEFAULT_CONTENT_POLICY,
    insert: async (_tx: unknown, values: NewAttachment) => {
      rows.push(values);
      return values;
    },
  } as unknown as MediaRepository;

  await new DeferredAttachmentSink(media).store(fakeTx(outbox), {
    brandId: BRAND,
    ticketId: TICKET,
    departmentId: DEPARTMENT,
    messageId: MESSAGE,
    contactId: CONTACT,
    accountId: ACCOUNT,
    refs,
    ids,
    ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
  });

  return { rows, outbox };
};

describe('what a reference declares', () => {
  it('takes a WhatsApp file’s kind from its type, so a photo sent as a document is a photo', () => {
    expect(declaredFile(whatsapp('image', 'image/jpeg'))).toMatchObject({
      kind: 'image',
      mime: 'image/jpeg',
    });
    expect(declaredFile(whatsapp('document', 'image/jpeg')).kind).toBe('image');
    expect(declaredFile(whatsapp('document', 'application/pdf')).kind).toBe('file');
    expect(declaredFile(whatsapp('sticker', 'image/webp')).kind).toBe('image');
  });

  it('strips the codec from a voice note’s type and calls it a voice note', () => {
    expect(declaredFile(whatsapp('audio', 'audio/ogg; codecs=opus', { voice: true }))).toEqual({
      kind: 'audio',
      mime: 'audio/ogg',
      label: 'voice-note',
    });
  });

  it('declares nothing for a link but a kind: the server says what it is', () => {
    expect(declaredFile(cdn('image'))).toEqual({ kind: 'image', mime: null, label: 'image' });
    expect(declaredFile(cdn('sticker')).kind).toBe('image');
    expect(declaredFile(cdn('file')).kind).toBe('file');
    expect(declaredFile(cdn('story_mention'))).toMatchObject({
      kind: 'image',
      label: 'story-mention',
    });
    expect(declaredFile(cdn('something-new')).kind).toBe('file');
  });
});

describe('a name for a file', () => {
  it('keeps the filename WhatsApp gave, stripped of any path', () => {
    expect(
      metaFileName(whatsapp('document', 'application/pdf', { filename: 'invoice-1042.pdf' }), null),
    ).toBe('invoice-1042.pdf');
    expect(
      metaFileName(whatsapp('document', 'application/pdf', { filename: '../../etc/passwd' }), null),
    ).toBe('passwd');
  });

  it('builds one from the kind and the type when there is none', () => {
    expect(metaFileName(whatsapp('image', 'image/jpeg'), 'image/jpeg')).toBe('image.jpg');
    expect(metaFileName(whatsapp('audio', 'audio/ogg', { voice: true }), 'audio/ogg')).toBe(
      'voice-note.ogg',
    );
    expect(metaFileName(cdn('video'), 'video/mp4')).toBe('video.mp4');
    expect(metaFileName(cdn('image'), null)).toBe('image');
    expect(metaFileName(cdn('image'), 'image/x-unknown')).toBe('image');
  });

  it('never builds one from the link, which carries Meta’s signature', () => {
    expect(metaFileName(cdn('image'), 'image/jpeg')).not.toContain('signature');
    expect(metaFileName(cdn('image'), 'image/jpeg')).not.toContain('fbcdn');
  });
});

describe('the deferred sink', () => {
  it('files a WhatsApp image pending, with no bytes, and asks for its fetch', async () => {
    const ref = whatsapp('image', 'image/jpeg');
    const { rows, outbox } = await run([ref]);

    expect(rows).toEqual([
      expect.objectContaining({
        id: ids[0],
        brandId: BRAND,
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        messageId: MESSAGE,
        uploaderType: 'contact',
        uploaderId: CONTACT,
        kind: 'image',
        mime: 'image/jpeg',
        size: 0,
        originalName: 'image.jpg',
        s3Key: `brands/${BRAND}/tickets/${TICKET}/${ids[0]}/original`,
      }),
    ]);
    expect(rows[0]?.status).toBeUndefined();
    expect(outbox).toEqual([
      {
        brandId: BRAND,
        event: 'meta.media',
        payload: { attachmentId: ids[0], accountId: ACCOUNT, ref },
      },
    ]);
  });

  it('files one row and one event per file, in order', async () => {
    const { rows, outbox } = await run([
      whatsapp('image', 'image/jpeg'),
      whatsapp('audio', 'audio/ogg; codecs=opus', { voice: true }),
    ]);

    expect(rows.map((row) => [row.id, row.kind, row.originalName])).toEqual([
      [ids[0], 'image', 'image.jpg'],
      [ids[1], 'audio', 'voice-note.ogg'],
    ]);
    expect(outbox.map((row) => row.payload.attachmentId)).toEqual([ids[0], ids[1]]);
  });

  it('files a link with a placeholder type, which the fetch replaces with the server’s', async () => {
    const { rows, outbox } = await run([cdn('image')]);

    expect(rows[0]).toMatchObject({ kind: 'image', mime: 'application/octet-stream', size: 0 });
    expect(outbox).toHaveLength(1);
  });

  it('records a file the brand switched off rejected, with no fetch', async () => {
    const { rows, outbox } = await run([whatsapp('image', 'image/jpeg')], {
      policy: policyWith({
        image: { enabled: false, maxBytes: 10_000_000, allowedMime: ['image/jpeg'] },
      }),
    });

    expect(rows).toEqual([
      expect.objectContaining({ status: 'rejected', rejectReason: 'kind_disabled' }),
    ]);
    expect(rows[0]?.processedAt).toBeInstanceOf(Date);
    expect(outbox).toEqual([]);
  });

  it('records a link of a kind that is off rejected too, though it declares no type', async () => {
    const { rows, outbox } = await run([cdn('video')], {
      policy: policyWith({
        video: { enabled: false, maxBytes: 10_000_000, allowedMime: ['video/mp4'] },
      }),
    });

    expect(rows[0]).toMatchObject({ status: 'rejected', rejectReason: 'kind_disabled' });
    expect(outbox).toEqual([]);
  });

  it('records a type the policy does not allow rejected, from the declaration alone', async () => {
    const { rows, outbox } = await run([whatsapp('audio', 'audio/amr')]);

    expect(rows[0]).toMatchObject({ status: 'rejected', rejectReason: 'mime_not_allowed' });
    expect(outbox).toEqual([]);
  });

  it('records what Meta already said it cannot serve rejected with that reason', async () => {
    const { rows, outbox } = await run([whatsapp('image', 'image/jpeg')], {
      refusal: 'unreadable',
    });

    expect(rows[0]).toMatchObject({ status: 'rejected', rejectReason: 'unreadable' });
    expect(outbox).toEqual([]);
  });

  it('leaves out the files past the brand’s cap per message', async () => {
    const { rows } = await run(
      [whatsapp('image', 'image/jpeg'), whatsapp('image', 'image/png'), cdn('image')],
      { policy: policyWith({ maxAttachmentsPerMessage: 2 }) },
    );

    expect(rows.map((row) => row.id)).toEqual([ids[0], ids[1]]);
  });
});
