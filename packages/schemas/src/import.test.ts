import { describe, expect, it } from 'vitest';
import {
  importArticleSchema,
  importAttachmentRefSchema,
  importBundlePathSchema,
  importCsatSchema,
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
  it('retains vendor display aliases only alongside a primary URL and refuses aliases on archive members', () => {
    const attachment = {
      externalId: 'native-file',
      fileName: 'manual.pdf',
      url: 'https://vendor.test/api/files/12',
      sourceUrls: ['https://vendor.test/view/file/12', 'https://vendor.test/download/file/12'],
    };
    expect(importAttachmentRefSchema.parse(attachment)).toEqual(attachment);
    const { url: _url, ...withoutPrimary } = attachment;
    expect(importAttachmentRefSchema.safeParse(withoutPrimary).success).toBe(false);
    expect(
      importAttachmentRefSchema.safeParse({
        ...withoutPrimary,
        bundlePath: 'attachments/manual.pdf',
      }).success,
    ).toBe(false);
  });
  it('retains explicit article assets without accepting duplicate native identities or ambiguous file locators', () => {
    const article = {
      externalId: 'original-article',
      sectionExternalId: 'original-section',
      locale: 'en',
      title: 'Original article',
      bodyHtml: '<p>Original content</p>',
      draft: false,
      internal: true,
      createdAt: '2013-11-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
      attachments: [
        {
          externalId: 'original-file',
          fileName: 'manual.pdf',
          bundlePath: 'attachments/manual.pdf',
          size: 123,
        },
      ],
    };
    expect(importArticleSchema.parse(article).attachments).toEqual(article.attachments);
    const published = {
      title: 'Original published title',
      bodyHtml: '<p>Published content only</p>',
      publishedAt: null,
      attachments: [
        {
          ...article.attachments[0]!,
          externalId: 'published-file',
          bundlePath: 'attachments/published-manual.pdf',
        },
      ],
    };
    const twoCopies = importArticleSchema.parse({ ...article, published });
    expect(twoCopies.published).toEqual(published);
    expect(twoCopies.attachments).toEqual(article.attachments);
    expect(importArticleSchema.safeParse({ ...article, published: null }).success).toBe(false);
    expect(
      importArticleSchema.safeParse({ ...article, draft: true, published: null }).success,
    ).toBe(true);
    expect(
      importArticleSchema.safeParse({
        ...article,
        attachments: [...article.attachments, ...article.attachments],
      }).success,
    ).toBe(false);
    expect(
      importArticleSchema.safeParse({
        ...article,
        attachments: [{ ...article.attachments[0], url: 'https://vendor.example/manual.pdf' }],
      }).success,
    ).toBe(false);
  });
  it('preserves an original author display separately from a local identity and refuses names beyond the storage bound', () => {
    const record = {
      entity: 'message',
      payload: {
        externalId: 'source-thread',
        ticketExternalId: 'source-ticket',
        authorKind: 'system',
        authorName: 'Original source name',
        public: false,
        bodyText: 'Historical note',
        attachments: [],
        createdAt: '2020-01-01T00:00:00Z',
      },
    };
    expect(importRecordSchema.parse(record)).toEqual(record);
    expect(
      importRecordSchema.safeParse({
        ...record,
        payload: { ...record.payload, authorName: 'x'.repeat(201) },
      }).success,
    ).toBe(false);
  });
  it('requires explicit provenance for an unscored answer and keeps native rating bounds', () => {
    const answer = {
      externalId: 'answer',
      ticketExternalId: 'ticket',
      ratedAt: '2020-01-01T00:00:00Z',
      rating: null,
    };
    expect(importCsatSchema.safeParse(answer).success).toBe(false);
    expect(
      importCsatSchema.safeParse({ ...answer, sourceDetails: { ratingUnmapped: 'true' } }).success,
    ).toBe(false);
    expect(
      importCsatSchema.safeParse({ ...answer, sourceDetails: { ratingUnmapped: true } }).success,
    ).toBe(true);
    for (const rating of [0, 6, 1.5])
      expect(importCsatSchema.safeParse({ ...answer, rating }).success).toBe(false);
  });
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

  it.each([0, -1, 1.5, 1000001, '2'])(
    'refuses an invalid attachment source-page hint %s',
    (sourcePage) => {
      expect(
        importAttachmentRefSchema.safeParse({
          externalId: 'a',
          fileName: 'a.pdf',
          url: 'https://example.test/a',
          sourcePage,
        }).success,
      ).toBe(false);
    },
  );

  it('accepts a bounded attachment page hint without changing its native ID', () => {
    expect(
      importAttachmentRefSchema.parse({
        externalId: 'native-a',
        fileName: 'a.pdf',
        url: 'https://example.test/a',
        sourcePage: 1000000,
      }),
    ).toMatchObject({ externalId: 'native-a', sourcePage: 1000000 });
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
