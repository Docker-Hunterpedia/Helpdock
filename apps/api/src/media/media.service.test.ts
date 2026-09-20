import { describe, expect, it } from 'vitest';
import { downloadName } from './media.service.js';
import { uploaderFor } from './uploader.js';

const STAFF = '01937f5e-7e53-7000-8000-000000000001';
const BRAND = '01937f5e-7e53-7000-8000-00000000000a';

describe('uploaderFor', () => {
  it('records a staff member as themselves', () => {
    expect(uploaderFor({ type: 'staff', id: STAFF, brands: {}, installAdmin: false })).toEqual({
      type: 'staff',
      id: STAFF,
    });
  });

  it('records a visitor as a contact, because the upload is the customer’s', () => {
    expect(
      uploaderFor({ type: 'visitor', id: STAFF, brandId: BRAND, conversationIds: [] }),
    ).toEqual({ type: 'contact', id: STAFF });
  });

  it('records an api key and a worker as system, told apart by the id', () => {
    expect(uploaderFor({ type: 'apikey', id: STAFF, brandId: BRAND, scopes: [] })).toEqual({
      type: 'system',
      id: STAFF,
    });
    expect(uploaderFor({ type: 'system', brandId: BRAND, jobId: 'media.process' })).toEqual({
      type: 'system',
      id: 'media.process',
    });
  });
});

describe('downloadName', () => {
  it('hands the original back under the name it was uploaded with', () => {
    expect(downloadName('Quarterly report.pdf', 'original')).toBe('Quarterly report.pdf');
  });

  it('names a derived variant after the upload, with its own extension', () => {
    // So a folder of downloads still says which message they came from.
    expect(downloadName('screenshot.png', 'webp')).toBe('screenshot-webp.webp');
    expect(downloadName('screenshot.png', 'thumb320')).toBe('screenshot-thumb320.webp');
    expect(downloadName('clip.mp4', 'poster')).toBe('clip-poster.webp');
    expect(downloadName('note.webm', 'opus')).toBe('note-opus.ogg');
  });

  it('copes with a name that has no extension at all', () => {
    expect(downloadName('screenshot', 'webp')).toBe('screenshot-webp.webp');
  });

  it('never produces an empty base name', () => {
    expect(downloadName('.png', 'webp')).toBe('attachment-webp.webp');
  });
});
