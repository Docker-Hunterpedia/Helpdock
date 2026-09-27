import { type AddressObject, type EmailAddress, type ParsedMail, simpleParser } from 'mailparser';
import type { InboundFile } from '../../adapter.js';
import {
  bareMessageId,
  type InboundEmail,
  lowerAddress,
  type MailAddress,
  messageIdsIn,
  synthesiseMessageId,
} from './inbound-email.js';

/**
 * RFC 5322 bytes to an {@link InboundEmail}, with mailparser (ARCHITECTURE §1).
 * IMAP delivers these bytes, and so do SendGrid's "raw" mode, Mailgun's
 * `mime` routes and the generic endpoint's `raw` field, so every transport
 * that can hand over the original message goes through the same parser.
 */

/** Larger than any provider's own inbound cap; a guard against a crafted stream. */
export const MAX_RAW_MESSAGE_BYTES = 40 * 1024 * 1024;

export class RawMessageTooLargeError extends Error {
  constructor(size: number) {
    super(`The message is ${String(size)} bytes, over the ${String(MAX_RAW_MESSAGE_BYTES)} limit`);
    this.name = 'RawMessageTooLargeError';
  }
}

const flatten = (value: AddressObject | AddressObject[] | undefined): EmailAddress[] => {
  if (value === undefined) {
    return [];
  }

  // A group ("undisclosed-recipients:;") nests its members one level down.
  return (Array.isArray(value) ? value : [value])
    .flatMap((object) => object.value)
    .flatMap((address) => (address.group === undefined ? [address] : address.group));
};

export const toMailAddresses = (addresses: readonly EmailAddress[]): MailAddress[] =>
  addresses
    .filter((address) => address.address !== undefined && address.address !== '')
    .map((address) => ({
      address: lowerAddress(address.address ?? ''),
      name: address.name.trim() === '' ? null : address.name.trim(),
    }));

/** Header lines as a multimap, unfolded, names lower-cased. */
export const headerMap = (
  lines: readonly { readonly key: string; readonly line: string }[],
): Map<string, string[]> => {
  const headers = new Map<string, string[]>();
  for (const { key, line } of lines) {
    const colon = line.indexOf(':');
    const value = (colon === -1 ? '' : line.slice(colon + 1)).replace(/\r?\n[ \t]+/g, ' ').trim();
    const name = key.toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }

  return headers;
};

const toFile = (attachment: ParsedMail['attachments'][number]): InboundFile => {
  const contentId =
    attachment.contentId === undefined ? null : bareMessageId(attachment.contentId) || null;

  return {
    filename: attachment.filename ?? 'attachment',
    contentType: attachment.contentType,
    content: Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(String(attachment.content)),
    contentId,
    // `related` is mailparser's word for "part of a multipart/related body",
    // which is where a `cid:` image lives; a part marked `inline` counts too.
    inline:
      contentId !== null &&
      (attachment.related === true || attachment.contentDisposition === 'inline'),
  };
};

export const parseRawEmail = async (raw: Buffer | string): Promise<InboundEmail> => {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > MAX_RAW_MESSAGE_BYTES) {
    throw new RawMessageTooLargeError(size);
  }

  // `keepCidLinks`: by default mailparser rewrites `cid:` references into
  // `data:` URIs, which would put every inline image into the body a second
  // time and past the sanitiser's scheme allowlist.
  const parsed = await simpleParser(raw, { keepCidLinks: true, skipTextToHtml: true });
  const from = toMailAddresses(flatten(parsed.from))[0] ?? null;
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  const text = parsed.text ?? null;
  const subject = parsed.subject ?? '';
  const date = parsed.date ?? null;

  return {
    messageId:
      parsed.messageId === undefined || bareMessageId(parsed.messageId) === ''
        ? synthesiseMessageId({
            from: from?.address ?? null,
            date,
            subject,
            body: text ?? html ?? '',
          })
        : bareMessageId(parsed.messageId),
    inReplyTo: messageIdsIn(parsed.inReplyTo)[0] ?? null,
    references: Array.isArray(parsed.references)
      ? parsed.references.flatMap((reference) => messageIdsIn(reference))
      : messageIdsIn(parsed.references),
    from,
    to: toMailAddresses(flatten(parsed.to)),
    cc: toMailAddresses(flatten(parsed.cc)),
    subject,
    date,
    html,
    text,
    headers: headerMap(parsed.headerLines),
    attachments: parsed.attachments.map(toFile),
  };
};
