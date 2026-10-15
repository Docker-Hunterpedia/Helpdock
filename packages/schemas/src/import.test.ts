import { describe, expect, it } from 'vitest';
import {
  importAttachmentRefSchema,
  importBundlePathSchema,
  importManifestSchema,
  importRecordSchema,
  importSectionSchema,
  importTicketSchema,
  importUrlSchema,
} from './import.js';

const ticket = {
  externalId: '0012',
  subject: 'Historical question',
  status: 'vendor-custom',
  ccEmails: [],
  tags: [],
  custom: { nested: { retained: true } },
  createdAt: '2019-01-01T12:00:00+03:00',
  updatedAt: '2019-01-02T09:00:00Z',
};

describe('normalised import boundaries', () => {
  it('preserves source IDs, original offset times and custom values through the discriminated record', () => {
    expect(importRecordSchema.parse({ entity: 'ticket', payload: ticket })).toEqual({
      entity: 'ticket',
      payload: ticket,
    });
    expect(importRecordSchema.safeParse({ entity: 'contact', payload: ticket }).success).toBe(
      false,
    );
  });

  it.each([
    { updatedAt: '2018-01-01T00:00:00Z' },
    { createdAt: '2019-01-01T12:00:00' },
    { externalId: ' ' },
  ])('refuses an unusable source identity or timestamp: %j', (overrides) => {
    expect(importTicketSchema.safeParse({ ...ticket, ...overrides }).success).toBe(false);
  });

  it.each([
    'not a URL',
    'https://user:secret@example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('safely refuses attachment address %s', (url) => {
    expect(importUrlSchema.safeParse(url).success).toBe(false);
  });

  it.each([
    '../attachment',
    'attachments/../secret',
    'attachments//secret',
    'attachments/./secret',
    'attachments/dir\\secret',
    'attachments/file\0name',
  ])('refuses unsafe bundle member %s', (path) => {
    expect(importBundlePathSchema.safeParse(path).success).toBe(false);
  });

  it('requires exactly one attachment location and accepts safe nested bundle members', () => {
    const ref = { externalId: 'a1', fileName: 'photo.png' };
    expect(importAttachmentRefSchema.safeParse(ref).success).toBe(false);
    expect(
      importAttachmentRefSchema.safeParse({
        ...ref,
        url: 'https://example.com/a',
        bundlePath: 'attachments/a',
      }).success,
    ).toBe(false);
    expect(
      importAttachmentRefSchema.parse({ ...ref, bundlePath: 'attachments/nested/photo.png' })
        .bundlePath,
    ).toBe('attachments/nested/photo.png');
  });

  it('keeps category name validation when a section adds its required parent', () => {
    expect(
      importSectionSchema.safeParse({ externalId: 's', parentExternalId: 'c', names: {} }).success,
    ).toBe(false);
    expect(
      importSectionSchema.parse({ externalId: 's', parentExternalId: 'c', names: { ar: 'الدعم' } })
        .names.ar,
    ).toBe('الدعم');
  });

  it('rejects unsupported bundle versions and entity count keys', () => {
    const manifest = {
      format: 'helpdock-import',
      version: 1,
      source: 'file',
      exportedAt: ticket.updatedAt,
      counts: { ticket: 1 },
    };
    expect(importManifestSchema.parse(manifest).counts.ticket).toBe(1);
    expect(importManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(false);
    expect(importManifestSchema.safeParse({ ...manifest, counts: { scripts: 1 } }).success).toBe(
      false,
    );
  });
});
