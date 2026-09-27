import { type ContentPolicy, contentPolicySchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { maxFilesFor, readSubmission, type ShownField, type UploadedFile } from './submission.js';

const POLICY = contentPolicySchema.parse({});

const field = (
  name: string,
  type: string,
  required = false,
  options: string[] = [],
): ShownField => ({
  field: name,
  type,
  required,
  options,
});

const SHOWN: readonly ShownField[] = [
  field('name', 'name'),
  field('email', 'email', true),
  field('subject', 'subject'),
  field('message', 'long_text', true),
];

const posted = (values: Record<string, string | string[]>) =>
  new Map(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' ? [value] : value,
    ]),
  );

const file = (filename: string, contentType: string, size = 10): UploadedFile => ({
  filename,
  contentType,
  content: Buffer.alloc(size),
});

const read = (
  values: Record<string, string | string[]>,
  options: { shown?: readonly ShownField[]; files?: UploadedFile[]; policy?: ContentPolicy } = {},
) =>
  readSubmission(
    options.shown ?? SHOWN,
    posted(values),
    options.files ?? [],
    options.policy ?? POLICY,
  );

describe('readSubmission', () => {
  it('trims, lower-cases the address, and leaves an optional blank field out', () => {
    const result = read({
      name: '  Omar ',
      email: ' Omar@Example.COM ',
      subject: '',
      message: ' Hi ',
    });

    expect(result).toEqual({
      ok: true,
      submission: {
        name: 'Omar',
        email: 'omar@example.com',
        subject: null,
        message: 'Hi',
        custom: {},
        files: [],
      },
    });
  });

  it('names each field that is missing, malformed or too long', () => {
    const result = read({ name: 'x'.repeat(201), email: 'omar@example', message: '' });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : Object.fromEntries(result.errors)).toEqual({
      name: 'too_long',
      email: 'email',
      message: 'required',
    });
  });

  it('reads only the fields the form shows', () => {
    const result = read({
      email: 'a@example.com',
      message: 'Hi',
      'custom:secret': 'typed by hand',
    });

    expect(result.ok && result.submission.custom).toEqual({});
  });

  it('turns custom fields into the values their types store', () => {
    const shown = [
      ...SHOWN,
      field('custom:order', 'number', true),
      field('custom:plan', 'select', false, ['Pro', 'Team']),
      field('custom:areas', 'multi_select', false, ['Billing', 'Login']),
      field('custom:urgent', 'checkbox'),
      field('custom:since', 'date'),
    ];

    const result = read(
      {
        email: 'a@example.com',
        message: 'Hi',
        'custom:order': '8841',
        'custom:plan': 'Pro',
        'custom:areas': ['Billing', 'Login'],
        'custom:urgent': 'on',
        'custom:since': '2026-09-01',
      },
      { shown },
    );

    expect(result.ok && result.submission.custom).toEqual({
      order: 8841,
      plan: 'Pro',
      areas: ['Billing', 'Login'],
      urgent: true,
      since: '2026-09-01',
    });
  });

  it('refuses a required custom field left empty and a choice nobody offered', () => {
    const shown = [
      ...SHOWN,
      field('custom:order', 'text', true),
      field('custom:plan', 'select', false, ['Pro']),
      field('custom:urgent', 'checkbox', true),
    ];

    const result = read(
      { email: 'a@example.com', message: 'Hi', 'custom:plan': 'Free' },
      { shown },
    );

    expect(result.ok ? null : Object.fromEntries(result.errors)).toEqual({
      'custom:order': 'required',
      'custom:plan': 'invalid',
      'custom:urgent': 'required',
    });
  });

  it('ignores the empty part a file control posts when nothing was chosen', () => {
    const result = read(
      { email: 'a@example.com', message: 'Hi' },
      {
        files: [
          { filename: '', contentType: 'application/octet-stream', content: Buffer.alloc(0) },
        ],
      },
    );

    expect(result.ok && result.submission.files).toEqual([]);
  });

  it('takes a file the policy allows, under a safe name, with its bare type', () => {
    const result = read(
      { email: 'a@example.com', message: 'Hi' },
      { files: [file('../receipt.pdf', 'application/pdf; name=receipt.pdf')] },
    );

    expect(result.ok && result.submission.files).toMatchObject([
      { filename: 'receipt.pdf', contentType: 'application/pdf', contentId: null, inline: false },
    ]);
  });

  it.each([
    ['a type the policy does not list', [file('a.exe', 'application/x-msdownload')], 'file_type'],
    ['a voice note, which belongs in chat', [file('a.ogg', 'audio/ogg')], 'file_type'],
    ['a file over the cap', [file('a.png', 'image/png', 11 * 1024 * 1024)], 'file_too_large'],
    [
      'more files than allowed',
      Array.from({ length: 6 }, (_, index) => file(`${String(index)}.pdf`, 'application/pdf')),
      'too_many_files',
    ],
  ])('refuses %s', (_label, files, code) => {
    const result = read({ email: 'a@example.com', message: 'Hi' }, { files });

    expect(result.ok ? null : result.errors.get('attachments')).toBe(code);
  });
});

describe('maxFilesFor', () => {
  it('is the policy’s count, never above five', () => {
    expect(maxFilesFor(POLICY)).toBe(5);
    expect(maxFilesFor({ ...POLICY, maxAttachmentsPerMessage: 3 })).toBe(3);
    expect(maxFilesFor({ ...POLICY, maxAttachmentsPerMessage: 10 })).toBe(5);
  });

  it('is zero when the brand takes neither images nor files', () => {
    expect(
      maxFilesFor({
        ...POLICY,
        image: { ...POLICY.image, enabled: false },
        file: { ...POLICY.file, enabled: false },
      }),
    ).toBe(0);
  });
});
