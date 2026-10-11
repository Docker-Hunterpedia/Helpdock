import { describe, expect, it } from 'vitest';
import { fileLeftOutText } from './meta-text.js';

const isolated = (name: string): string => `⁨${name}⁩`;

describe('fileLeftOutText', () => {
  it('says Instagram takes PDF files only, naming the file, in English', () => {
    expect(
      fileLeftOutText({
        locale: 'en',
        platform: 'instagram',
        name: 'warranty-terms.docx',
        reason: 'unsupported-type',
        isFile: true,
      }),
    ).toBe(
      `One file could not be sent here: ${isolated('warranty-terms.docx')}. Instagram only takes PDF files, so we will send it another way.`,
    );
  });

  it('says it in Arabic, with the platform in Arabic and the name isolated', () => {
    const text = fileLeftOutText({
      locale: 'ar',
      platform: 'instagram',
      name: 'warranty-terms.docx',
      reason: 'unsupported-type',
      isFile: true,
    });

    expect(text).toContain(isolated('warranty-terms.docx'));
    expect(text).toContain('إنستغرام');
    expect(text).toContain('PDF');
  });

  it('does not blame the file list for an image or a clip the platform does not list', () => {
    const text = fileLeftOutText({
      locale: 'en',
      platform: 'instagram',
      name: 'label.webp',
      reason: 'unsupported-type',
      isFile: false,
    });

    expect(text).toBe(
      `One file could not be sent here: ${isolated('label.webp')}. Instagram does not take this kind of file, so we will send it another way.`,
    );
  });

  it('does not say PDF for a platform whose files are not limited to it', () => {
    const text = fileLeftOutText({
      locale: 'en',
      platform: 'whatsapp',
      name: 'notes.bin',
      reason: 'unsupported-type',
      isFile: true,
    });

    expect(text).not.toContain('PDF');
  });

  it('says it is the size when it is', () => {
    expect(
      fileLeftOutText({
        locale: 'en',
        platform: 'whatsapp',
        name: 'recording.zip',
        reason: 'too-large',
        isFile: true,
      }),
    ).toBe(
      `One file could not be sent here: ${isolated('recording.zip')}. It is larger than WhatsApp allows, so we will send it another way.`,
    );
  });
});
