import {
  type GenericInboundEmail,
  genericInboundEmailSchema,
  type InboundParseProvider,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { InboundFile } from '../../adapter.js';
import {
  bareMessageId,
  type InboundEmail,
  type InboundEnvelope,
  lowerAddress,
  type MailAddress,
  messageIdsIn,
  recipientsOf,
  synthesiseMessageId,
} from './inbound-email.js';
import { parseRawEmail } from './parse-mime.js';

/**
 * The five inbound-parse payloads (M2-03) to one {@link InboundEnvelope}.
 *
 * Wherever a provider can hand over the original RFC 5322 message — Postmark's
 * `RawEmail`, SendGrid's "Send raw" `email` field, Mailgun's `body-mime`, the
 * generic `raw` — that is what is parsed, with the same parser as IMAP. The
 * structured fields are the fallback for providers configured without it.
 */

/** A request body, as the controller decoded it. Nothing web-specific crosses into this package. */
export type InboundPayload =
  | { readonly kind: 'json'; readonly body: unknown }
  | {
      readonly kind: 'form';
      readonly fields: ReadonlyMap<string, string>;
      readonly files: ReadonlyMap<string, InboundUpload>;
    };

export interface InboundUpload {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

/** The payload is not what the provider sends. The endpoint answers 400. */
export class InboundPayloadError extends Error {
  constructor(provider: InboundParseProvider, detail: string) {
    super(`This is not a ${provider} inbound payload: ${detail}`);
    this.name = 'InboundPayloadError';
  }
}

/**
 * Resend's `email.received` webhook carries the envelope and no body: the body
 * has to be fetched from Resend's Receiving API with an API key, which this
 * build does not hold. A payload that includes `html` or `text` — a relay that
 * fetched it, or Resend's "include content" option — is accepted; one without
 * is refused with this, so the provider's own log says why.
 */
export class InboundBodyMissingError extends Error {
  constructor() {
    super(
      'The Resend payload has no html or text. Fetch the message from the Receiving API and post it here, or post it to the generic endpoint.',
    );
    this.name = 'InboundBodyMissingError';
  }
}

const decodeHeaderBlock = (block: string): Map<string, string[]> => {
  const headers = new Map<string, string[]>();
  for (const line of block
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]+/g, ' ')
    .split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
  }

  return headers;
};

/** `"Mona Khalil" <Mona@Example.com>, b@example.com` → two addresses. */
export const parseAddressList = (value: string | null | undefined): MailAddress[] => {
  if (value === null || value === undefined || value.trim() === '') {
    return [];
  }

  // Commas inside a quoted display name do not separate addresses.
  const parts = value.match(/(?:"[^"]*"|[^,])+/g) ?? [];

  return parts
    .map((part) => {
      const angle = /<([^<>]+)>/.exec(part);
      const address = lowerAddress(angle?.[1] ?? part.replace(/"[^"]*"/g, ''));
      const name = angle === null ? '' : part.slice(0, angle.index).replace(/"/g, '').trim();

      return { address, name: name === '' ? null : name };
    })
    .filter((address) => address.address.includes('@'));
};

const first = <T>(values: readonly T[]): T | null => values[0] ?? null;

const parseDate = (value: string | null | undefined): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
};

interface StructuredParts {
  readonly headers: Map<string, string[]>;
  readonly from: MailAddress | null;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string;
  readonly html: string | null;
  readonly text: string | null;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly date: Date | null;
  readonly attachments: readonly InboundFile[];
}

const emailFrom = (parts: StructuredParts): InboundEmail => ({
  messageId:
    parts.messageId === null || bareMessageId(parts.messageId) === ''
      ? synthesiseMessageId({
          from: parts.from?.address ?? null,
          date: parts.date,
          subject: parts.subject,
          body: parts.text ?? parts.html ?? '',
        })
      : bareMessageId(parts.messageId),
  inReplyTo: parts.inReplyTo === null ? null : (messageIdsIn(parts.inReplyTo)[0] ?? null),
  references: parts.references,
  from: parts.from,
  to: parts.to,
  cc: parts.cc,
  subject: parts.subject,
  date: parts.date,
  html: parts.html,
  text: parts.text,
  headers: parts.headers,
  attachments: parts.attachments,
});

const headerOf = (headers: Map<string, string[]>, name: string): string | null =>
  headers.get(name)?.[0] ?? null;

const nonEmpty = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value;

// --------------------------------------------------------------------------
// Postmark
// --------------------------------------------------------------------------

const postmarkAddress = z.object({ Email: z.string(), Name: z.string().optional() });

const postmarkSchema = z.object({
  FromFull: postmarkAddress.optional(),
  From: z.string().optional(),
  ToFull: z.array(postmarkAddress).optional(),
  CcFull: z.array(postmarkAddress).optional(),
  OriginalRecipient: z.string().optional(),
  Subject: z.string().optional(),
  Date: z.string().optional(),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).optional(),
  Attachments: z
    .array(
      z.object({
        Name: z.string(),
        Content: z.string(),
        ContentType: z.string(),
        ContentID: z.string().optional(),
      }),
    )
    .optional(),
  RawEmail: z.string().optional(),
});

const fromPostmarkAddress = (value: z.infer<typeof postmarkAddress>): MailAddress => ({
  address: lowerAddress(value.Email),
  name: nonEmpty(value.Name?.trim()),
});

const postmark = async (payload: InboundPayload): Promise<InboundEnvelope> => {
  if (payload.kind !== 'json') {
    throw new InboundPayloadError('postmark', 'expected JSON');
  }
  const parsed = postmarkSchema.safeParse(payload.body);
  if (!parsed.success) {
    throw new InboundPayloadError('postmark', parsed.error.message);
  }
  const body = parsed.data;
  const envelope = body.OriginalRecipient === undefined ? [] : [body.OriginalRecipient];

  if (body.RawEmail !== undefined && body.RawEmail !== '') {
    const email = await parseRawEmail(body.RawEmail);
    return { email, recipients: recipientsOf(email, envelope) };
  }

  const headers = new Map<string, string[]>();
  for (const { Name, Value } of body.Headers ?? []) {
    const name = Name.toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), Value]);
  }

  const email = emailFrom({
    headers,
    from:
      body.FromFull === undefined
        ? first(parseAddressList(body.From))
        : fromPostmarkAddress(body.FromFull),
    to: (body.ToFull ?? []).map(fromPostmarkAddress),
    cc: (body.CcFull ?? []).map(fromPostmarkAddress),
    subject: body.Subject ?? '',
    html: nonEmpty(body.HtmlBody),
    text: nonEmpty(body.TextBody),
    // Postmark's own `MessageID` is its id, not the sender's; the sender's is a header.
    messageId: headerOf(headers, 'message-id'),
    inReplyTo: headerOf(headers, 'in-reply-to'),
    references: messageIdsIn(headerOf(headers, 'references')),
    date: parseDate(body.Date),
    attachments: (body.Attachments ?? []).map((attachment) => {
      const contentId =
        attachment.ContentID === undefined ? null : bareMessageId(attachment.ContentID) || null;
      return {
        filename: attachment.Name,
        contentType: attachment.ContentType,
        content: Buffer.from(attachment.Content, 'base64'),
        contentId,
        inline: contentId !== null,
      };
    }),
  });

  return { email, recipients: recipientsOf(email, envelope) };
};

// --------------------------------------------------------------------------
// SendGrid Inbound Parse and Mailgun routes (multipart forms)
// --------------------------------------------------------------------------

const envelopeRecipients = (value: string | undefined): string[] => {
  if (value === undefined) {
    return [];
  }
  try {
    const parsed = z.object({ to: z.array(z.string()) }).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data.to : [];
  } catch {
    return [];
  }
};

const jsonRecord = (value: string | undefined): Record<string, unknown> => {
  if (value === undefined) {
    return {};
  }
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

const uploadsOf = (
  files: ReadonlyMap<string, InboundUpload>,
  contentIdOf: (field: string) => string | null,
): InboundFile[] =>
  [...files.entries()]
    .filter(([field]) => /^attachment-?\d+$/.test(field))
    .map(([field, file]) => {
      const contentId = contentIdOf(field);
      return {
        filename: file.filename,
        contentType: file.contentType,
        content: file.content,
        contentId,
        inline: contentId !== null,
      };
    });

const sendgrid = async (payload: InboundPayload): Promise<InboundEnvelope> => {
  if (payload.kind !== 'form') {
    throw new InboundPayloadError('sendgrid', 'expected multipart/form-data');
  }
  const { fields, files } = payload;
  const envelope = envelopeRecipients(fields.get('envelope'));

  const raw = fields.get('email');
  if (raw !== undefined && raw !== '') {
    const email = await parseRawEmail(raw);
    return { email, recipients: recipientsOf(email, envelope) };
  }

  if (!fields.has('from')) {
    throw new InboundPayloadError('sendgrid', 'no from field');
  }

  const headers = decodeHeaderBlock(fields.get('headers') ?? '');
  // `attachment-info` maps `attachment1` to its metadata, `content-id` included.
  const info = jsonRecord(fields.get('attachment-info'));
  const email = emailFrom({
    headers,
    from: first(parseAddressList(fields.get('from'))),
    to: parseAddressList(fields.get('to')),
    cc: parseAddressList(fields.get('cc')),
    subject: fields.get('subject') ?? '',
    html: nonEmpty(fields.get('html')),
    text: nonEmpty(fields.get('text')),
    messageId: headerOf(headers, 'message-id'),
    inReplyTo: headerOf(headers, 'in-reply-to'),
    references: messageIdsIn(headerOf(headers, 'references')),
    date: parseDate(headerOf(headers, 'date')),
    attachments: uploadsOf(files, (field) => {
      const meta = z.object({ 'content-id': z.string() }).safeParse(info[field]);
      return meta.success ? bareMessageId(meta.data['content-id']) || null : null;
    }),
  });

  return { email, recipients: recipientsOf(email, envelope) };
};

const mailgun = async (payload: InboundPayload): Promise<InboundEnvelope> => {
  if (payload.kind !== 'form') {
    throw new InboundPayloadError('mailgun', 'expected multipart/form-data');
  }
  const { fields, files } = payload;
  const envelope = (fields.get('recipient') ?? '')
    .split(',')
    .filter((value) => value.trim() !== '');

  const raw = fields.get('body-mime');
  if (raw !== undefined && raw !== '') {
    const email = await parseRawEmail(raw);
    return { email, recipients: recipientsOf(email, envelope) };
  }

  if (!fields.has('from') && !fields.has('sender')) {
    throw new InboundPayloadError('mailgun', 'no from or sender field');
  }

  const headers = new Map<string, string[]>();
  try {
    const pairs = z
      .array(z.tuple([z.string(), z.string()]))
      .safeParse(JSON.parse(fields.get('message-headers') ?? '[]'));
    for (const [name, value] of pairs.success ? pairs.data : []) {
      const key = name.toLowerCase();
      headers.set(key, [...(headers.get(key) ?? []), value]);
    }
  } catch {
    // A malformed header list is treated as none; the fields below still carry the essentials.
  }

  // `content-id-map` is `{"<cid>": "attachment-1"}`: invert it.
  const byField = new Map(
    Object.entries(jsonRecord(fields.get('content-id-map'))).map(([cid, field]) => [
      String(field),
      bareMessageId(cid),
    ]),
  );
  const email = emailFrom({
    headers,
    from: first(parseAddressList(fields.get('from') ?? fields.get('sender'))),
    to: parseAddressList(fields.get('To') ?? headerOf(headers, 'to')),
    cc: parseAddressList(fields.get('Cc') ?? headerOf(headers, 'cc')),
    subject: fields.get('subject') ?? '',
    html: nonEmpty(fields.get('body-html')),
    text: nonEmpty(fields.get('body-plain')),
    messageId: fields.get('Message-Id') ?? headerOf(headers, 'message-id'),
    inReplyTo: fields.get('In-Reply-To') ?? headerOf(headers, 'in-reply-to'),
    references: messageIdsIn(fields.get('References') ?? headerOf(headers, 'references')),
    date: parseDate(fields.get('Date') ?? headerOf(headers, 'date')),
    attachments: uploadsOf(files, (field) => byField.get(field) ?? null),
  });

  return { email, recipients: recipientsOf(email, envelope) };
};

// --------------------------------------------------------------------------
// Resend
// --------------------------------------------------------------------------

const resendSchema = z.object({
  type: z.string().optional(),
  data: z.object({
    from: z.string(),
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    received_for: z.array(z.string()).default([]),
    subject: z.string().default(''),
    message_id: z.string().optional(),
    created_at: z.string().optional(),
    html: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().default('attachment'),
          content_type: z.string().default('application/octet-stream'),
          content_id: z.string().nullable().optional(),
          content_disposition: z.string().nullable().optional(),
          /** Base64, present only when the relay fetched it. */
          content: z.string().optional(),
        }),
      )
      .default([]),
  }),
});

const resend = async (payload: InboundPayload): Promise<InboundEnvelope> => {
  if (payload.kind !== 'json') {
    throw new InboundPayloadError('resend', 'expected JSON');
  }
  const parsed = resendSchema.safeParse(payload.body);
  if (!parsed.success) {
    throw new InboundPayloadError('resend', parsed.error.message);
  }
  const { data } = parsed.data;
  if (nonEmpty(data.html) === null && nonEmpty(data.text) === null) {
    throw new InboundBodyMissingError();
  }

  const headers = new Map<string, string[]>(
    Object.entries(data.headers ?? {}).map(([name, value]) => [name.toLowerCase(), [value]]),
  );
  const email = emailFrom({
    headers,
    from: first(parseAddressList(data.from)),
    to: data.to.flatMap((to) => parseAddressList(to)),
    cc: data.cc.flatMap((cc) => parseAddressList(cc)),
    subject: data.subject,
    html: nonEmpty(data.html),
    text: nonEmpty(data.text),
    messageId: data.message_id ?? headerOf(headers, 'message-id'),
    inReplyTo: headerOf(headers, 'in-reply-to'),
    references: messageIdsIn(headerOf(headers, 'references')),
    date: parseDate(data.created_at),
    attachments: data.attachments
      .filter((attachment) => attachment.content !== undefined)
      .map((attachment) => {
        const contentId = nonEmpty(attachment.content_id ?? null);
        return {
          filename: attachment.filename,
          contentType: attachment.content_type,
          content: Buffer.from(attachment.content ?? '', 'base64'),
          contentId: contentId === null ? null : bareMessageId(contentId),
          inline: contentId !== null && attachment.content_disposition !== 'attachment',
        };
      }),
  });

  await Promise.resolve();
  return { email, recipients: recipientsOf(email, data.received_for) };
};

// --------------------------------------------------------------------------
// Generic JSON
// --------------------------------------------------------------------------

const toAddress = (value: { address: string; name?: string | undefined }): MailAddress => ({
  address: lowerAddress(value.address),
  name: nonEmpty(value.name?.trim()),
});

const generic = async (payload: InboundPayload): Promise<InboundEnvelope> => {
  if (payload.kind !== 'json') {
    throw new InboundPayloadError('generic', 'expected JSON');
  }
  const parsed = genericInboundEmailSchema.safeParse(payload.body);
  if (!parsed.success) {
    throw new InboundPayloadError('generic', parsed.error.message);
  }
  const body: GenericInboundEmail = parsed.data;

  if ('raw' in body) {
    const email = await parseRawEmail(body.raw);
    return { email, recipients: recipientsOf(email) };
  }

  const headers = new Map<string, string[]>(
    Object.entries(body.headers ?? {}).map(([name, value]) => [name.toLowerCase(), [value]]),
  );
  const email = emailFrom({
    headers,
    from: toAddress(body.from),
    to: body.to.map(toAddress),
    cc: (body.cc ?? []).map(toAddress),
    subject: body.subject,
    html: nonEmpty(body.html),
    text: nonEmpty(body.text),
    messageId: body.messageId ?? null,
    inReplyTo: body.inReplyTo ?? null,
    references: (body.references ?? []).map(bareMessageId),
    date: parseDate(body.date),
    attachments: (body.attachments ?? []).map((attachment) => {
      const contentId =
        attachment.contentId === undefined ? null : bareMessageId(attachment.contentId) || null;
      return {
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.content, 'base64'),
        contentId,
        inline: attachment.inline ?? contentId !== null,
      };
    }),
  });

  return { email, recipients: recipientsOf(email) };
};

const PARSERS: Record<InboundParseProvider, (payload: InboundPayload) => Promise<InboundEnvelope>> =
  {
    postmark,
    sendgrid,
    mailgun,
    resend,
    generic,
  };

export const parseInboundPayload = (
  provider: InboundParseProvider,
  payload: InboundPayload,
): Promise<InboundEnvelope> => PARSERS[provider](payload);
