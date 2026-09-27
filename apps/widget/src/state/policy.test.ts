import { describe, expect, it } from 'vitest';
import { samplePolicy } from '../transport/fixtures.js';
import type { ContentPolicy } from '../transport/types.js';
import { acceptList, canAttach, checkFiles, formatBytes, kindOf, mimeAllowed } from './policy.js';

const MB = 1024 * 1024;
const off = { enabled: false, max_bytes: 0, allowed_mime: [] };

describe('kindOf and mimeAllowed', () => {
  it('sorts a MIME type into the policy kind that governs it', () => {
    expect(kindOf('image/png')).toBe('image');
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf('application/pdf')).toBe('file');
  });

  it('matches exact types and type/* wildcards, ignoring parameters and case', () => {
    expect(mimeAllowed('IMAGE/PNG', ['image/*'])).toBe(true);
    expect(mimeAllowed('audio/webm;codecs=opus', ['audio/webm'])).toBe(true);
    expect(mimeAllowed('application/zip', ['application/pdf'])).toBe(false);
  });
});

describe('checkFiles', () => {
  it('accepts files inside their kind’s caps', () => {
    expect(checkFiles([{ name: 'a.png', type: 'image/png', size: MB }], samplePolicy)).toBeNull();
  });

  it('names the file, its size and the cap when a video is too large (WidgetStatesEN column 3)', () => {
    expect(
      checkFiles([{ name: 'unboxing.mov', type: 'video/mp4', size: 48 * MB }], samplePolicy),
    ).toEqual({
      key: 'attachment.tooLarge.video',
      vars: { name: 'unboxing.mov', size: '48 MB', max: '25 MB' },
    });
  });

  it('refuses a type the brand does not allow, and any file of a disabled kind', () => {
    expect(
      checkFiles([{ name: 'x.zip', type: 'application/zip', size: 1 }], samplePolicy)?.key,
    ).toBe('attachment.typeRejected');
    const noImages: ContentPolicy = { ...samplePolicy, image: off };
    expect(checkFiles([{ name: 'a.png', type: 'image/png', size: 1 }], noImages)?.key).toBe(
      'attachment.typeRejected',
    );
  });

  it('refuses more files than one message may carry', () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      name: `${index}.png`,
      type: 'image/png',
      size: 1,
    }));

    expect(checkFiles(files, samplePolicy)).toEqual({
      key: 'attachment.tooMany',
      vars: { max: 5 },
    });
  });
});

describe('the composer controls', () => {
  it('hides the paperclip only when every file kind is off', () => {
    expect(canAttach(samplePolicy)).toBe(true);
    expect(canAttach({ ...samplePolicy, image: off, video: off, file: off })).toBe(false);
  });

  it('builds the picker’s accept list from the enabled kinds', () => {
    expect(acceptList({ ...samplePolicy, video: off })).toBe('image/*,application/pdf,text/plain');
  });
});

describe('formatBytes', () => {
  it('prints KB below a megabyte and MB above it', () => {
    expect(formatBytes(84 * 1024)).toBe('84 KB');
    expect(formatBytes(100)).toBe('1 KB');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
  });
});
