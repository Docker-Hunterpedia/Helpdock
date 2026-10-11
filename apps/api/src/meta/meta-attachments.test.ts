import type { Attachment } from '@helpdock/db';
import { META_ATTACHMENT_LIMITS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  customerIsTold,
  type MetaOutgoingPlan,
  outgoingFileName,
  planOutgoingFile,
} from './meta-attachments.js';

const MIB = 1024 * 1024;

type Kind = Attachment['kind'];

const stored = (mime: string, size = 1_000) => ({ mime, size });

const ready = (
  platform: Parameters<typeof planOutgoingFile>[1],
  kind: Kind,
  variants: Record<string, unknown>,
): MetaOutgoingPlan => planOutgoingFile({ status: 'ready', kind, variants }, platform);

describe('planOutgoingFile: what the pipeline is still doing or refused', () => {
  it('waits for a file the pipeline is still working on', () => {
    for (const status of ['pending', 'processing'] as const) {
      expect(planOutgoingFile({ status, kind: 'file', variants: {} }, 'whatsapp')).toEqual({
        kind: 'wait',
      });
    }
  });

  it('leaves out a file the pipeline refused, without telling the customer', () => {
    for (const status of ['rejected', 'infected'] as const) {
      const plan = planOutgoingFile({ status, kind: 'file', variants: {} }, 'messenger');

      expect(plan).toEqual({ kind: 'skip', reason: 'not-sendable' });
    }
    expect(customerIsTold('not-sendable')).toBe(false);
  });

  it('leaves out a ready file that has no object to send', () => {
    expect(ready('whatsapp', 'file', {})).toEqual({ kind: 'skip', reason: 'not-sendable' });
    expect(ready('whatsapp', 'video', { poster: stored('image/webp') })).toEqual({
      kind: 'skip',
      reason: 'not-sendable',
    });
  });
});

describe('planOutgoingFile on WhatsApp', () => {
  it('sends a JPEG or PNG original as an image, the kept original before the WebP', () => {
    expect(
      ready('whatsapp', 'image', {
        original: stored('image/jpeg', 900),
        webp: stored('image/webp'),
      }),
    ).toEqual({
      kind: 'send',
      method: 'image',
      variant: 'original',
      size: 900,
      mime: 'image/jpeg',
    });
  });

  it('sends the pipeline’s WebP, which WhatsApp does not take as an image, as a document', () => {
    expect(ready('whatsapp', 'image', { webp: stored('image/webp', 700) })).toEqual({
      kind: 'send',
      method: 'document',
      variant: 'webp',
      size: 700,
      mime: 'image/webp',
    });
  });

  it('sends an image over 5 MiB as a document, which takes 100 MiB', () => {
    expect(ready('whatsapp', 'image', { original: stored('image/png', 6 * MIB) })).toMatchObject({
      method: 'document',
      variant: 'original',
    });
  });

  it('sends a voice note’s Opus as audio and an MP4 as video', () => {
    expect(
      ready('whatsapp', 'audio', {
        opus: stored('audio/ogg'),
        original: stored('audio/webm'),
      }),
    ).toMatchObject({ method: 'audio', variant: 'opus' });
    expect(ready('whatsapp', 'video', { original: stored('video/mp4', 10 * MIB) })).toMatchObject({
      method: 'video',
    });
  });

  it('sends a video WhatsApp does not take, or one over 16 MiB, as a document', () => {
    expect(ready('whatsapp', 'video', { original: stored('video/webm') })).toMatchObject({
      method: 'document',
    });
    expect(ready('whatsapp', 'video', { original: stored('video/mp4', 17 * MIB) })).toMatchObject({
      method: 'document',
    });
  });

  it('sends any file as a document up to 100 MiB and leaves out what is past it', () => {
    expect(ready('whatsapp', 'file', { original: stored('application/zip', 100 * MIB) })).toEqual({
      kind: 'send',
      method: 'document',
      variant: 'original',
      size: 100 * MIB,
      mime: 'application/zip',
    });
    expect(
      ready('whatsapp', 'file', { original: stored('application/zip', 100 * MIB + 1) }),
    ).toEqual({ kind: 'skip', reason: 'too-large' });
  });
});

describe('planOutgoingFile on Messenger', () => {
  it('sends each kind as its own, whatever the type, up to 25 MiB', () => {
    expect(ready('messenger', 'image', { webp: stored('image/webp') })).toMatchObject({
      method: 'image',
      variant: 'webp',
    });
    expect(ready('messenger', 'audio', { opus: stored('audio/ogg') })).toMatchObject({
      method: 'audio',
    });
    expect(ready('messenger', 'file', { original: stored('application/msword') })).toMatchObject({
      method: 'document',
    });
  });

  it('leaves out a file past 25 MiB, saying it is the size', () => {
    expect(
      ready('messenger', 'file', {
        original: stored('application/pdf', META_ATTACHMENT_LIMITS.messenger.file + 1),
      }),
    ).toEqual({ kind: 'skip', reason: 'too-large' });
  });
});

describe('planOutgoingFile on Instagram', () => {
  it('sends a PDF as the one kind of file it takes, up to 25 MiB', () => {
    expect(ready('instagram', 'file', { original: stored('application/pdf', 25 * MIB) })).toEqual({
      kind: 'send',
      method: 'document',
      variant: 'original',
      size: 25 * MIB,
      mime: 'application/pdf',
    });
    expect(
      ready('instagram', 'file', { original: stored('application/pdf', 25 * MIB + 1) }),
    ).toEqual({ kind: 'skip', reason: 'too-large' });
  });

  it('leaves out a Word or Excel file for its type, and the customer is told', () => {
    for (const mime of [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
    ]) {
      expect(ready('instagram', 'file', { original: stored(mime) })).toEqual({
        kind: 'skip',
        reason: 'unsupported-type',
      });
    }
    expect(customerIsTold('unsupported-type')).toBe(true);
    expect(customerIsTold('too-large')).toBe(true);
  });

  it('sends a JPEG up to 8 MiB as an image and leaves out one past it', () => {
    expect(ready('instagram', 'image', { original: stored('image/jpeg', 8 * MIB) })).toMatchObject({
      method: 'image',
    });
    // A document is not an alternative here: Instagram files are PDF only.
    expect(ready('instagram', 'image', { original: stored('image/jpeg', 8 * MIB + 1) })).toEqual({
      kind: 'skip',
      reason: 'too-large',
    });
  });

  it('leaves out the pipeline’s WebP and Opus, which Instagram does not list', () => {
    expect(ready('instagram', 'image', { webp: stored('image/webp') })).toEqual({
      kind: 'skip',
      reason: 'unsupported-type',
    });
    expect(ready('instagram', 'audio', { opus: stored('audio/ogg') })).toEqual({
      kind: 'skip',
      reason: 'unsupported-type',
    });
  });

  it('sends an M4A or a WebM, which it lists, and falls back to the original', () => {
    expect(
      ready('instagram', 'audio', {
        opus: stored('audio/ogg'),
        original: stored('audio/x-m4a'),
      }),
    ).toMatchObject({ method: 'audio', variant: 'original' });
    expect(ready('instagram', 'video', { original: stored('video/webm') })).toMatchObject({
      method: 'video',
    });
  });
});

describe('outgoingFileName', () => {
  it('keeps the upload’s name for the original and names a derived object for what it is', () => {
    expect(outgoingFileName({ originalName: 'label.jpg' }, 'original')).toBe('label.jpg');
    expect(outgoingFileName({ originalName: 'label.jpg' }, 'webp')).toBe('label-webp.webp');
  });
});
