import { describe, expect, it } from 'vitest';
import {
  keepsOriginal,
  servesInline,
  VARIANT_EXTENSION,
  VARIANT_MIME,
  variantsFor,
} from './variants.js';

/**
 * The numbers ARCHITECTURE §9 fixes — 2048 px, quality 82, 320 and 960,
 * Opus at 48 kHz mono, a poster one second in — are not asserted here as
 * constants equalling their own literals. They are asserted where they are
 * *observable*: `process.job.test.ts` measures the widths sharp produced, and
 * `ffmpeg.integration.test.ts` probes the codec, sample rate and channel count
 * ffmpeg wrote.
 */

describe('variantsFor', () => {
  it('plans what ARCHITECTURE §9 asks for, per kind', () => {
    expect(variantsFor('image')).toEqual(['webp', 'thumb320', 'thumb960']);
    expect(variantsFor('audio')).toEqual(['opus']);
    expect(variantsFor('video')).toEqual(['poster']);
    // A file is stored, scanned and served. Nothing is made of it.
    expect(variantsFor('file')).toEqual([]);
  });

  it('gives every derived variant a content type and an extension', () => {
    for (const kind of ['image', 'audio', 'video', 'file'] as const) {
      for (const variant of variantsFor(kind)) {
        expect(VARIANT_MIME[variant], variant).toBeDefined();
        expect(VARIANT_EXTENSION[variant], variant).toBeDefined();
      }
    }
  });
});

describe('keepsOriginal', () => {
  it('always keeps a video and a file, because there is nothing else to serve', () => {
    expect(keepsOriginal('video', false)).toBe(true);
    expect(keepsOriginal('file', false)).toBe(true);
  });

  it('discards the uploaded image and voice note unless the brand asked to keep them', () => {
    // The re-encoded copy is the safe one; the original is the one that carried
    // whatever was in it (REQUIREMENTS §5.1).
    expect(keepsOriginal('image', false)).toBe(false);
    expect(keepsOriginal('audio', false)).toBe(false);
    expect(keepsOriginal('image', true)).toBe(true);
    expect(keepsOriginal('audio', true)).toBe(true);
  });
});

describe('servesInline', () => {
  it('renders only what this install encoded', () => {
    for (const variant of ['webp', 'thumb320', 'thumb960', 'poster', 'opus'] as const) {
      expect(servesInline(variant), variant).toBe(true);
    }
  });

  it('never renders the uploaded bytes, whatever their type claims', () => {
    // REQUIREMENTS §5.1 asks for `Content-Disposition: attachment` on
    // everything that is not an image, and bytes this install did not write are
    // bytes it cannot vouch for — including an uploaded PNG.
    expect(servesInline('original')).toBe(false);
  });
});
