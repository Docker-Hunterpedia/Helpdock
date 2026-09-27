import type { InboundFile } from '@helpdock/channels';
import {
  type ContentPolicy,
  type CustomFieldType,
  customKeyOfRef,
  customValueSchema,
  safeFileName,
  WEB_FORM_EMAIL_MAX,
  WEB_FORM_MAX_FILES,
  WEB_FORM_MESSAGE_MAX,
  WEB_FORM_NAME_MAX,
  WEB_FORM_SUBJECT_MAX,
  type WebFormFieldError,
} from '@helpdock/schemas';
import { z } from 'zod';
import { kindForMime } from '../channels/inbound/attachment-sink.js';
import { checkUpload, PolicyRefusal } from '../media/content-policy.js';
import { ARTICLE_FIELD } from './page/render.js';

/**
 * One submission of the public form, read and checked before anything is
 * written (M4-09). Pure: the page controller hands in what the browser posted,
 * and gets back either a submission to file or a code per field for the page
 * to name in the customer's language.
 *
 * Only the fields the form shows are read. A field the Admin hid is not a
 * field a stranger may fill by hand-writing a request.
 */

/** What this file needs of a shown field: its reference, how it is typed, whether it is required. */
export interface ShownField {
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly options: readonly string[];
}

/** One uploaded part, as the multipart parser hands it over. */
export interface UploadedFile {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface WebFormSubmission {
  readonly name: string | null;
  readonly email: string;
  readonly subject: string | null;
  readonly message: string;
  readonly custom: Record<string, unknown>;
  readonly files: readonly InboundFile[];
}

export type SubmissionResult =
  | { readonly ok: true; readonly submission: WebFormSubmission }
  | { readonly ok: false; readonly errors: ReadonlyMap<string, WebFormFieldError> };

/** The attachments control's name; not a field of the layout. */
export const ATTACHMENTS_FIELD = 'attachments';

/** The kinds a hosted form accepts. Voice and video belong to the chat widget. */
export const WEB_FORM_ATTACHMENT_KINDS = ['image', 'file'] as const;

const emailSchema = z.email().max(WEB_FORM_EMAIL_MAX);

const first = (fields: ReadonlyMap<string, readonly string[]>, name: string): string =>
  (fields.get(name)?.[0] ?? '').trim();

const articleIdSchema = z.uuid();

/**
 * M5-08: the article "Still need help?" came from, when the value is a uuid.
 * Anything else is dropped rather than refused: the field is hidden, and the
 * ticket is what the customer came to file.
 */
export const articleIdFrom = (value: string | undefined): string | null => {
  const parsed = articleIdSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data : null;
};

export const postedArticleId = (fields: ReadonlyMap<string, readonly string[]>): string | null =>
  articleIdFrom(fields.get(ARTICLE_FIELD)?.[0]);

/** How many files the form takes, after the brand's content policy has had its say. */
export const maxFilesFor = (policy: ContentPolicy): number => {
  const anyKind = WEB_FORM_ATTACHMENT_KINDS.some((kind) => policy[kind].enabled);
  return anyKind ? Math.min(policy.maxAttachmentsPerMessage, WEB_FORM_MAX_FILES) : 0;
};

const readBuiltin = (
  field: ShownField,
  value: string,
): { value: string | null; error?: WebFormFieldError } => {
  if (value === '') {
    return field.required ? { value: null, error: 'required' } : { value: null };
  }
  switch (field.field) {
    case 'email':
      return emailSchema.safeParse(value).success
        ? { value: value.toLowerCase() }
        : { value: null, error: value.length > WEB_FORM_EMAIL_MAX ? 'too_long' : 'email' };
    case 'name':
      return value.length > WEB_FORM_NAME_MAX ? { value: null, error: 'too_long' } : { value };
    case 'subject':
      return value.length > WEB_FORM_SUBJECT_MAX ? { value: null, error: 'too_long' } : { value };
    default:
      return value.length > WEB_FORM_MESSAGE_MAX ? { value: null, error: 'too_long' } : { value };
  }
};

/**
 * A custom field's value from the strings a form posts: a checkbox is present
 * or absent, a multi-select repeats its name, everything else is one string.
 */
const readCustom = (
  field: ShownField,
  raw: readonly string[],
): { value: unknown; error?: WebFormFieldError } => {
  const type = field.type as CustomFieldType;
  const values = raw.map((value) => value.trim()).filter((value) => value !== '');

  let candidate: unknown;
  if (type === 'checkbox') {
    candidate = values.length > 0 ? true : undefined;
  } else if (type === 'multi_select') {
    candidate = values.length > 0 ? values : undefined;
  } else {
    candidate = values[0];
  }

  if (candidate === undefined) {
    return field.required ? { value: undefined, error: 'required' } : { value: undefined };
  }
  const parsed = customValueSchema({
    key: field.field,
    type,
    options: field.options,
    required: true,
  }).safeParse(candidate);
  return parsed.success ? { value: parsed.data } : { value: undefined, error: 'invalid' };
};

const checkFiles = (
  uploads: readonly UploadedFile[],
  policy: ContentPolicy,
): { files: InboundFile[]; error?: WebFormFieldError } => {
  // A file input with nothing chosen still posts one empty, nameless part.
  const chosen = uploads.filter((file) => file.filename !== '' || file.content.length > 0);
  if (chosen.length === 0) {
    return { files: [] };
  }
  if (chosen.length > maxFilesFor(policy)) {
    return { files: [], error: 'too_many_files' };
  }

  const files: InboundFile[] = [];
  for (const upload of chosen) {
    const mime = (upload.contentType.split(';')[0] ?? '').trim().toLowerCase();
    const kind = kindForMime(mime);
    if (!(WEB_FORM_ATTACHMENT_KINDS as readonly string[]).includes(kind)) {
      return { files: [], error: 'file_type' };
    }
    try {
      checkUpload(policy, { kind, mime, size: upload.content.length });
    } catch (error) {
      if (!(error instanceof PolicyRefusal)) {
        throw error;
      }
      return { files: [], error: error.reason === 'too_large' ? 'file_too_large' : 'file_type' };
    }
    files.push({
      filename: safeFileName(upload.filename),
      contentType: mime,
      content: upload.content,
      contentId: null,
      inline: false,
    });
  }
  return { files };
};

export const readSubmission = (
  shown: readonly ShownField[],
  fields: ReadonlyMap<string, readonly string[]>,
  uploads: readonly UploadedFile[],
  policy: ContentPolicy,
): SubmissionResult => {
  const errors = new Map<string, WebFormFieldError>();
  const builtins = new Map<string, string | null>();
  const custom: Record<string, unknown> = {};

  for (const field of shown) {
    const key = customKeyOfRef(field.field);
    if (key === null) {
      const read = readBuiltin(field, first(fields, field.field));
      builtins.set(field.field, read.value);
      if (read.error !== undefined) {
        errors.set(field.field, read.error);
      }
      continue;
    }
    const read = readCustom(field, fields.get(field.field) ?? []);
    if (read.error !== undefined) {
      errors.set(field.field, read.error);
    } else if (read.value !== undefined) {
      custom[key] = read.value;
    }
  }

  const attachments = checkFiles(uploads, policy);
  if (attachments.error !== undefined) {
    errors.set(ATTACHMENTS_FIELD, attachments.error);
  }

  const email = builtins.get('email');
  const message = builtins.get('message');
  if (errors.size > 0 || email == null || message == null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    submission: {
      name: builtins.get('name') ?? null,
      email,
      subject: builtins.get('subject') ?? null,
      message,
      custom,
      files: attachments.files,
    },
  };
};
