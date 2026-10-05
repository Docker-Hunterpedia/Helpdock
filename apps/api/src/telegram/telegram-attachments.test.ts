import { describe, expect, it } from 'vitest';
import {
  planOutgoingFile,
  TELEGRAM_PHOTO_MAX_BYTES,
  TELEGRAM_UPLOAD_MAX_BYTES,
} from './telegram-attachments.js';

const ready = (kind: 'image' | 'audio' | 'video' | 'file', variants: Record<string, unknown>) =>
  planOutgoingFile({ status: 'ready', kind, variants });

const variant = (mime: string, size = 1_000) => ({ mime, size });

describe('planOutgoingFile', () => {
  it('waits for a file the pipeline is still working on', () => {
    expect(planOutgoingFile({ status: 'pending', kind: 'file', variants: {} })).toEqual({
      kind: 'wait',
    });
    expect(planOutgoingFile({ status: 'processing', kind: 'image', variants: {} })).toEqual({
      kind: 'wait',
    });
  });

  it('leaves out a file the pipeline refused', () => {
    expect(planOutgoingFile({ status: 'rejected', kind: 'file', variants: {} })).toEqual({
      kind: 'skip',
    });
    expect(planOutgoingFile({ status: 'infected', kind: 'file', variants: {} })).toEqual({
      kind: 'skip',
    });
  });

  it('sends an image as a photo, the kept original first, else the WebP', () => {
    expect(ready('image', { webp: variant('image/webp', 900) })).toEqual({
      kind: 'send',
      method: 'photo',
      variant: 'webp',
      size: 900,
    });
    expect(
      ready('image', { original: variant('image/png', 1_200), webp: variant('image/webp') }),
    ).toMatchObject({ method: 'photo', variant: 'original' });
  });

  it('sends an image too large for sendPhoto as a document', () => {
    expect(
      ready('image', { webp: variant('image/webp', TELEGRAM_PHOTO_MAX_BYTES + 1) }),
    ).toMatchObject({ method: 'document', variant: 'webp' });
  });

  it('sends a voice note’s Opus, and any other file’s original, as a document', () => {
    expect(ready('audio', { opus: variant('audio/ogg'), original: variant('audio/mpeg') })).toEqual(
      { kind: 'send', method: 'document', variant: 'opus', size: 1_000 },
    );
    expect(ready('file', { original: variant('application/pdf') })).toMatchObject({
      method: 'document',
      variant: 'original',
    });
  });

  it('leaves out what Telegram would refuse: nothing to send, or past 50 MB', () => {
    expect(ready('file', {})).toEqual({ kind: 'skip' });
    expect(ready('video', { poster: variant('image/webp') })).toEqual({ kind: 'skip' });
    expect(
      ready('file', { original: variant('application/zip', TELEGRAM_UPLOAD_MAX_BYTES + 1) }),
    ).toEqual({ kind: 'skip' });
  });
});
