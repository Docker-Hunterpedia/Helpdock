import { describe, expect, it } from 'vitest';
import { extractFile, isKnowledgeFileMime } from './files.js';
import { minimalDocx, minimalPdf } from './fixtures.js';

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
