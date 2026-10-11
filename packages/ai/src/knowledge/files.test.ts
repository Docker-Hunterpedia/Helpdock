import mammoth from 'mammoth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFile, isKnowledgeFileMime } from './files.js';
import { craftedZip, minimalDocx, minimalPdf } from './fixtures.js';
import {
  ArchiveRejectedError,
  assertArchiveWithinLimits,
  DOCX_MAX_ENTRIES,
  DOCX_MAX_UNCOMPRESSED_BYTES,
} from './zip-limits.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractFile', () => {
  it('reads a PDF page by page, so a chunk can cite its page', async () => {
    const document = await extractFile(
      minimalPdf([['Refunds take five days.'], ['Exchanges are free.']]),
      'application/pdf',
      'Billing FAQ.pdf',
    );

    expect(document.title).toBe('Billing FAQ');
    expect(document.parts.map((part) => [part.meta, part.text.trim()])).toEqual([
      [{ page: 1 }, 'Refunds take five days.'],
      [{ page: 2 }, 'Exchanges are free.'],
    ]);
  });

  it('keeps the headings of a DOCX as Markdown headings', async () => {
    const document = await extractFile(
      minimalDocx(['# Refund policy', 'Within 30 days.', '## Exceptions', 'Gift cards.']),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'policy.docx',
    );

    expect(document.title).toBe('Refund policy');
    expect(document.parts[0]?.text).toBe(
      '# Refund policy\n\nWithin 30 days.\n\n## Exceptions\n\nGift cards.',
    );
  });

  describe('a DOCX that unpacks to more than it should (ASVS 12.1.2)', () => {
    const refuses = async (archive: Uint8Array) => {
      const convert = vi.spyOn(mammoth, 'convertToHtml');
      await expect(extractFile(archive, DOCX, 'bomb.docx')).rejects.toBeInstanceOf(
        ArchiveRejectedError,
      );
      expect(convert).not.toHaveBeenCalled();
    };

    it('refuses an entry whose directory declares more than the cap, before reading it', async () => {
      await refuses(craftedZip([{ name: 'word/document.xml', declaredSize: 1024 * 1024 * 1024 }]));
    });

    it('refuses entries that together declare more than the cap', async () => {
      const share = Math.ceil(DOCX_MAX_UNCOMPRESSED_BYTES / 2) + 1;
      await refuses(
        craftedZip([
          { name: 'word/document.xml', declaredSize: share },
          { name: 'word/media/image1.png', declaredSize: share },
        ]),
      );
    });

    it('refuses more entries than the cap', async () => {
      await refuses(
        craftedZip(
          Array.from({ length: DOCX_MAX_ENTRIES + 1 }, (_, index) => ({
            name: `word/media/${index}.png`,
            declaredSize: 1,
          })),
        ),
      );
    });

    it('refuses an entry that unpacks to more than its directory says', async () => {
      const lie = Buffer.alloc(5 * 1024 * 1024, 0x20);
      await refuses(craftedZip([{ name: 'word/document.xml', declaredSize: 100, inflated: lie }]));
    });

    it.each([
      ['not a ZIP at all', new Uint8Array(64)],
      ['a ZIP that was cut short', craftedZip([{ name: 'a', declaredSize: 0 }]).slice(0, -10)],
    ])('refuses %s', async (_label, archive) => {
      await refuses(archive);
    });

    it('accepts deflated entries that unpack to exactly what they declare', () => {
      const text = Buffer.alloc(10_000, 0x20);

      expect(() =>
        assertArchiveWithinLimits(
          craftedZip([{ name: 'word/document.xml', declaredSize: text.length, inflated: text }]),
        ),
      ).not.toThrow();
    });

    it('still reads an ordinary DOCX of a few entries', async () => {
      const convert = vi.spyOn(mammoth, 'convertToHtml');

      await extractFile(minimalDocx(['# Refund policy']), DOCX, 'policy.docx');

      expect(convert).toHaveBeenCalledOnce();
    });
  });

  it('takes Markdown as written and titles it by its first heading', async () => {
    const document = await extractFile(
      new TextEncoder().encode('Intro\n\n## Shipping\n\nTwo days.'),
      'text/markdown',
      'notes.md',
    );

    expect(document).toEqual({
      title: 'Shipping',
      parts: [{ text: 'Intro\n\n## Shipping\n\nTwo days.' }],
    });
  });

  it('ignores a heading marker with nothing after it, in Markdown and in a DOCX, in linear time', async () => {
    const started = performance.now();
    const blanks = ' '.repeat(100_000);
    const markdown = await extractFile(
      new TextEncoder().encode(`#${blanks}\n# ${blanks}Title${blanks}`),
      'text/markdown',
      'notes.md',
    );
    const docx = await extractFile(
      minimalDocx([`##${blanks}`, '## Kept']),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'policy.docx',
    );

    expect(markdown.title).toBe('Title');
    expect(docx.title).toBe('Kept');
    expect(docx.parts[0]?.text).toMatch(/^##\s*\n\n## Kept$/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('titles plain text without a heading by its file name', async () => {
    const document = await extractFile(
      new TextEncoder().encode('Opening hours are 9 to 5.'),
      'text/plain',
      'hours.txt',
    );

    expect(document.title).toBe('hours');
  });

  it('accepts the four knowledge types and nothing else', () => {
    expect(isKnowledgeFileMime('application/pdf')).toBe(true);
    expect(isKnowledgeFileMime('text/markdown')).toBe(true);
    expect(isKnowledgeFileMime('application/zip')).toBe(false);
  });
});
