import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES_CEILING,
  attachmentPresignRequestSchema,
  attachmentVariantsSchema,
  contentPolicySchema,
  DEFAULT_ATTACHMENTS_PER_MESSAGE,
  DEFAULT_CONTENT_POLICY,
  mediaPolicySchema,
  mimeTypeSchema,
  policyFieldFor,
  policyFor,
  safeFileName,
} from './media.js';

const MIB = 1_048_576;

describe('contentPolicySchema', () => {
  it('fills a whole policy from nothing, so a brand created before a kind exists needs no backfill', () => {
    const policy = contentPolicySchema.parse({});

    expect(policy).toEqual(DEFAULT_CONTENT_POLICY);
    expect(policy.text).toBe(true);
    expect(policy.emoji).toBe(true);
    expect(policy.maxAttachmentsPerMessage).toBe(DEFAULT_ATTACHMENTS_PER_MESSAGE);
    // Keeping the bytes a stranger uploaded is opt-in: re-encoding exists to
    // get rid of them (REQUIREMENTS §5.1).
    expect(policy.keepOriginals).toBe(false);
  });

  it('ships the caps and types ARCHITECTURE §9 and REQUIREMENTS §4.6 name', () => {
    const policy = contentPolicySchema.parse({});

    expect(policy.image).toEqual({
      enabled: true,
      maxBytes: 10 * MIB,
      allowedMime: ['image/webp', 'image/jpeg', 'image/png', 'image/gif'],
    });
    expect(policy.video.maxBytes).toBe(50 * MIB);
    expect(policy.video.allowedMime).toEqual(['video/mp4', 'video/webm']);
    // What MediaRecorder produces on Chromium and on Safari, plus what the
    // worker normalises both to.
    expect(policy.voice.maxBytes).toBe(5 * MIB);
    expect(policy.voice.allowedMime).toEqual(['audio/ogg', 'audio/webm', 'audio/mp4']);
    expect(policy.file.maxBytes).toBe(25 * MIB);
    expect(policy.file.allowedMime).toContain('application/pdf');
    expect(policy.file.allowedMime).toContain('text/plain');
    expect(policy.file.allowedMime).toContain('application/zip');
  });

  it('keeps a brand that has only overridden one kind on the defaults for the rest', () => {
    const policy = contentPolicySchema.parse({
      video: { enabled: false, maxBytes: 1_000, allowedMime: ['video/mp4'] },
    });

    expect(policy.video.enabled).toBe(false);
    expect(policy.image).toEqual(DEFAULT_CONTENT_POLICY.image);
  });

  it('refuses a cap above the install ceiling, whoever is editing the brand', () => {
    expect(
      mediaPolicySchema.safeParse({
        enabled: true,
        maxBytes: ATTACHMENT_MAX_BYTES_CEILING + 1,
        allowedMime: ['image/png'],
      }).success,
    ).toBe(false);
  });

  it('refuses a kind that is enabled with nothing allowed, which is a kind that is off', () => {
    expect(
      mediaPolicySchema.safeParse({ enabled: true, maxBytes: 1_000, allowedMime: [] }).success,
    ).toBe(false);
  });

  it('refuses more attachments per message than the install ceiling', () => {
    expect(contentPolicySchema.safeParse({ maxAttachmentsPerMessage: 21 }).success).toBe(false);
    expect(contentPolicySchema.safeParse({ maxAttachmentsPerMessage: 0 }).success).toBe(true);
  });

  it('freezes the shipped default, so nothing can retune every brand at runtime', () => {
    expect(Object.isFrozen(DEFAULT_CONTENT_POLICY)).toBe(true);
  });
});

describe('policyFor', () => {
  it('reads audio against the brand\u2019s voice switch, which is what §4.6 calls it', () => {
    expect(policyFieldFor('audio')).toBe('voice');
    expect(policyFor(DEFAULT_CONTENT_POLICY, 'audio')).toBe(DEFAULT_CONTENT_POLICY.voice);
  });

  it('reads the other three under their own names', () => {
    for (const kind of ['image', 'video', 'file'] as const) {
      expect(policyFor(DEFAULT_CONTENT_POLICY, kind)).toBe(DEFAULT_CONTENT_POLICY[kind]);
    }
  });
});

describe('mimeTypeSchema', () => {
  it('lower-cases and trims what a policy names', () => {
    expect(mimeTypeSchema.parse('  IMAGE/PNG ')).toBe('image/png');
  });

  it('refuses a wildcard, so a brand cannot allow what the pipeline cannot encode', () => {
    expect(mimeTypeSchema.safeParse('image/*').success).toBe(false);
  });

  it('refuses parameters and anything that is not one type and one subtype', () => {
    for (const value of ['text/plain; charset=utf-8', 'image', 'image/', '/png', 'a/b/c']) {
      expect(mimeTypeSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('attachmentVariantsSchema', () => {
  it('accepts a row with no variants at all', () => {
    expect(attachmentVariantsSchema.parse({})).toEqual({});
  });

  it('accepts a partial set, because a PDF has an original and nothing else', () => {
    const variants = attachmentVariantsSchema.parse({
      original: { mime: 'application/pdf', size: 1_024 },
    });

    expect(variants.original?.size).toBe(1_024);
    expect(variants.webp).toBeUndefined();
  });

  it('refuses a variant name nothing writes', () => {
    expect(
      attachmentVariantsSchema.safeParse({ thumb1024: { mime: 'image/webp', size: 1 } }).success,
    ).toBe(false);
  });
});

describe('attachmentPresignRequestSchema', () => {
  it('takes a claim about what is about to be sent', () => {
    expect(
      attachmentPresignRequestSchema.parse({
        kind: 'image',
        mime: 'image/png',
        size: 1_024,
        fileName: 'screenshot.png',
      }),
    ).toEqual({ kind: 'image', mime: 'image/png', size: 1_024, fileName: 'screenshot.png' });
  });

  it('refuses a zero-byte upload, which has nothing to presign for', () => {
    expect(
      attachmentPresignRequestSchema.safeParse({
        kind: 'image',
        mime: 'image/png',
        size: 0,
        fileName: 'empty.png',
      }).success,
    ).toBe(false);
  });
});

describe('safeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(safeFileName('Quarterly report.pdf')).toBe('Quarterly report.pdf');
  });

  it('drops every path a name could be carrying', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(safeFileName('/absolute/path/report.pdf')).toBe('report.pdf');
  });

  it('removes control characters, so the name cannot close a header or forge a log line', () => {
    expect(safeFileName('inv\u0000oice\r\n.pdf')).toBe('invoice.pdf');
  });

  it('refuses to produce a dotfile or an empty name', () => {
    expect(safeFileName('...')).toBe('attachment');
    expect(safeFileName('   ')).toBe('attachment');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName('/')).toBe('attachment');
  });

  it('caps the length, because a name is stored, logged and put in a header', () => {
    expect(safeFileName(`${'a'.repeat(400)}.png`)).toHaveLength(255);
  });

  it('keeps a name that is not ASCII, which the header encodes rather than strips', () => {
    expect(safeFileName('تقرير.pdf')).toBe('تقرير.pdf');
  });
});
