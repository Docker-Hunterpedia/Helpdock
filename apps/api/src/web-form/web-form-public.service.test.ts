import type { Db } from '@helpdock/db';
import { contentPolicySchema } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { WebFormRepository } from './web-form.repository.js';
import {
  attachmentsFor,
  type LoadedForm,
  megabytes,
  pageLocale,
  WebFormPublicService,
} from './web-form-public.service.js';
import type { WebFormTicketWriter } from './web-form-ticket.writer.js';

const POLICY = contentPolicySchema.parse({});

describe('pageLocale', () => {
  it('takes a shipped locale from the query, and the brand’s otherwise', () => {
    expect(pageLocale('ar', 'en')).toBe('ar');
    expect(pageLocale('fr', 'ar')).toBe('ar');
    expect(pageLocale(undefined, 'en')).toBe('en');
  });
});

describe('megabytes', () => {
  it('isolates the size so Arabic text keeps it in order', () => {
    expect(megabytes(10 * 1024 * 1024)).toBe('⁨10 MB⁩');
    expect(megabytes(2.5 * 1024 * 1024)).toBe('⁨2.5 MB⁩');
  });
});

describe('attachmentsFor', () => {
  it('offers the image and file types, and says both caps when they differ', () => {
    const attachments = attachmentsFor(POLICY, 'en');

    expect(attachments?.max).toBe(5);
    expect(attachments?.accept).toContain('image/png');
    expect(attachments?.accept).toContain('application/pdf');
    expect(attachments?.accept).not.toContain('audio/ogg');
    expect(attachments?.hint).toContain('Up to 5 files.');
    expect(attachments?.hint).toContain('Images up to ⁨10 MB⁩, other files up to ⁨25 MB⁩.');
    expect(attachments?.hint).toMatch(/PDF, DOCX, XLSX, TXT, or ZIP\.$/);
  });

  it('gives one cap when only one kind is on, in Arabic too', () => {
    const attachments = attachmentsFor(
      { ...POLICY, file: { ...POLICY.file, enabled: false }, maxAttachmentsPerMessage: 1 },
      'ar',
    );

    expect(attachments?.hint).toContain('ملف واحد.');
    expect(attachments?.hint).toContain('حتى ⁨10 MB⁩ لكل ملف.');
    expect(attachments?.accept).not.toContain('application/pdf');
  });

  it('draws no control when the brand takes no files', () => {
    expect(attachmentsFor({ ...POLICY, maxAttachmentsPerMessage: 0 }, 'en')).toBeNull();
  });
});

describe('WebFormPublicService.submit before anything is read', () => {
  const service = () => {
    const limiter = { consume: vi.fn(async () => true) };
    const writer = { alreadyFiled: vi.fn(), file: vi.fn() };
    const instance = new WebFormPublicService({
      db: {} as Db,
      repository: {} as WebFormRepository,
      writer: writer as unknown as WebFormTicketWriter,
      captchaKeys: { forBrand: async () => null },
      captchaTransport: { postForm: vi.fn() },
      limiter: limiter as unknown as RateLimiter,
      sink: vi.fn(),
      removeObject: vi.fn(),
      log: { warn: vi.fn() },
    });
    return { instance, limiter, writer };
  };

  const form = {
    brand: { id: 'brand-1' },
    fields: [
      { field: 'email', label: 'Email', type: 'email', required: true, options: [] },
      { field: 'message', label: 'Message', type: 'long_text', required: true, options: [] },
    ],
    policy: POLICY,
  } as unknown as LoadedForm;

  const post = (fields: Record<string, string>) => ({
    fields: new Map(Object.entries(fields).map(([key, value]) => [key, [value]])),
    files: [],
    ip: '203.0.113.1',
  });

  it('refuses a filled honeypot without reading a field or spending a limit', async () => {
    const { instance, limiter, writer } = service();

    expect(
      await instance.submit(form, post({ hd_website: 'x', email: 'a@example.com', message: 'Hi' })),
    ).toEqual({ kind: 'refused', error: 'rejected' });
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(writer.file).not.toHaveBeenCalled();
  });

  it('answers the fields that need attention without spending a limit', async () => {
    const { instance, limiter } = service();

    const result = await instance.submit(form, post({ email: 'nope', message: '' }));

    expect(result.kind).toBe('invalid');
    expect(limiter.consume).not.toHaveBeenCalled();
  });
});
