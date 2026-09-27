import { sanitizeMessageHtml } from '../../html/sanitize.js';
import { htmlToText } from '../../html/text.js';

/**
 * An inbound email's body, made safe and made readable (M2-04, M2-07).
 *
 * Three things happen, in this order, and the order is the point:
 *
 * 1. **The quoted reply is cut off** — everything from the first quote marker
 *    a mail client writes. It is kept, sanitised, behind "Show quoted text",
 *    because a thread in which every reply repeats the whole history is a
 *    thread nobody can read.
 * 2. **Both halves are sanitised** by the one allowlist every message in the
 *    install goes through (ADR 0007). Scripts, forms and styles go.
 * 3. **Every `<img>` leaves the body.** A `cid:` image is an attachment of this
 *    message and is drawn as an inline figure from the attachment row; a remote
 *    one is recorded and drawn only when an agent asks, or through the proxy
 *    (REQUIREMENTS §5.1: "remote images proxied/blocked"). `body_html` therefore
 *    never contains a URL that fires on render, whichever screen renders it.
 */

export interface RemoteImage {
  readonly url: string;
  readonly alt: string;
}

export interface ProcessedBody {
  /** Sanitised, quote-free, image-free. What `ticket_messages.body_html` stores. */
  readonly html: string;
  readonly text: string;
  /** Sanitised quoted history, or null when there was none. */
  readonly quotedHtml: string | null;
  readonly remoteImages: readonly RemoteImage[];
  /** `Content-ID`s the body showed with `cid:`, in order, without duplicates. */
  readonly inlineContentIds: readonly string[];
}

/**
 * The first element a client wraps quoted history in. Gmail's `gmail_quote`,
 * Apple Mail's and Thunderbird's `<blockquote type="cite">`, Outlook's
 * `divRplyFwdMsg` and `appendonsend`, Yahoo's `yahoo_quoted`, and the
 * `moz-cite-prefix` line Thunderbird puts above a quote.
 */
const HTML_QUOTE_MARKERS: readonly RegExp[] = [
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b/i,
  /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b/i,
  /<div\b[^>]*\bid\s*=\s*["']?(?:divRplyFwdMsg|appendonsend)\b/i,
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:yahoo_quoted|moz-cite-prefix)\b/i,
  /-{2,}\s*Original Message\s*-{2,}/i,
];

/**
 * The attribution line a client writes just above the quote, when it writes
 * it outside the quote's own element: "On Tue, 15 Sep 2026, Mona wrote:" and
 * its Arabic form, "كتب:". Only a *trailing* one is removed, and only up to a
 * few hundred characters, so a sentence in the reply itself that happens to
 * end in "wrote:" is left alone.
 */
const TRAILING_ATTRIBUTION =
  /(?:<(?:div|p|span)\b[^>]*>\s*)?(?:On\b|في\s)[^<]{0,300}(?:wrote|كتب[^<:\n]{0,80})\s*:\s*(?:<br\s*\/?>\s*)*(?:<\/(?:div|p|span)>\s*)?(?:<br\s*\/?>\s*)*$/i;

/** The same markers in a plain-text body. */
const TEXT_QUOTE_START: readonly RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  /^(?:On\b|في\s).{0,300}(?:wrote|كتب[^<:\n]{0,80})\s*:\s*$/im,
  /^>/m,
];

const firstMatch = (source: string, patterns: readonly RegExp[]): number => {
  let first = -1;
  for (const pattern of patterns) {
    const index = source.search(pattern);
    if (index !== -1 && (first === -1 || index < first)) {
      first = index;
    }
  }

  return first;
};

/** Splits HTML at the first quote marker. The halves are unbalanced; the sanitiser's parser balances them. */
export const splitHtmlQuote = (html: string): { reply: string; quoted: string | null } => {
  const index = firstMatch(html, HTML_QUOTE_MARKERS);
  if (index <= 0) {
    // A body that *starts* with the quote is a forward, or a reply written
    // under the quote. Cutting it would leave nothing, so it is kept whole.
    return { reply: html, quoted: null };
  }

  return {
    reply: html.slice(0, index).replace(TRAILING_ATTRIBUTION, ''),
    quoted: html.slice(index),
  };
};

export const splitTextQuote = (text: string): { reply: string; quoted: string | null } => {
  const index = firstMatch(text, TEXT_QUOTE_START);
  if (index <= 0 || text.slice(0, index).trim() === '') {
    return { reply: text, quoted: null };
  }

  return { reply: text.slice(0, index).trimEnd(), quoted: text.slice(index) };
};

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Plain text as paragraphs, one per blank-line-separated block, lines kept with `<br>`. */
export const textToHtml = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map(
      (block) =>
        `<p>${block
          .replace(/[&<>"']/g, (character) => ESCAPE[character] ?? character)
          .replace(/\n/g, '<br />')}</p>`,
    )
    .join('');

const UNESCAPE: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

const attribute = (tag: string, name: string): string | null => {
  // Sanitiser output: lower-case names, double-quoted, entity-escaped values.
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  if (match === null) {
    return null;
  }

  return UNESCAPE.reduce(
    (value, [pattern, character]) => value.replace(pattern, character),
    match[1] ?? '',
  );
};

/**
 * Takes every `<img>` out of already-sanitised HTML. Safe to do with a pattern
 * because the input is the sanitiser's own output — one tag shape, quoted
 * attributes, no comments — not the sender's markup.
 */
export const extractImages = (
  sanitised: string,
): { html: string; remote: RemoteImage[]; contentIds: string[] } => {
  const remote: RemoteImage[] = [];
  const contentIds: string[] = [];

  const html = sanitised.replace(/<img\b[^>]*>/g, (tag) => {
    const src = attribute(tag, 'src')?.trim() ?? '';
    const alt = attribute(tag, 'alt') ?? '';
    if (/^cid:/i.test(src)) {
      const id = decodeURIComponent(src.slice(4)).replace(/^<|>$/g, '');
      if (id !== '' && !contentIds.includes(id)) {
        contentIds.push(id);
      }
    } else if (/^https?:\/\//i.test(src) && URL.canParse(src)) {
      remote.push({ url: src, alt });
    }

    return '';
  });

  return { html, remote, contentIds };
};

/** A body that is nothing but whitespace and empty wrappers once the images went. */
const isEmptyMarkup = (html: string): boolean => htmlToText(html) === '';

export const processEmailBody = (source: {
  readonly html: string | null;
  readonly text: string | null;
}): ProcessedBody => {
  const fromHtml = source.html !== null && source.html.trim() !== '';
  const split = fromHtml
    ? splitHtmlQuote(source.html ?? '')
    : (() => {
        const text = splitTextQuote(source.text ?? '');
        return {
          reply: textToHtml(text.reply),
          quoted: text.quoted === null ? null : textToHtml(text.quoted),
        };
      })();

  const reply = extractImages(sanitizeMessageHtml(split.reply, { imageSrc: 'allow-remote' }));
  const quoted =
    split.quoted === null
      ? null
      : extractImages(sanitizeMessageHtml(split.quoted, { imageSrc: 'allow-remote' }));

  const quotedHtml = quoted === null || isEmptyMarkup(quoted.html) ? null : quoted.html;

  return {
    html: reply.html,
    text: htmlToText(reply.html),
    quotedHtml,
    // Images in the quoted history are the earlier message's, already shown on
    // it; only the reply's own count.
    remoteImages: reply.remote,
    inlineContentIds: reply.contentIds,
  };
};
