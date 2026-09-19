import sanitizeHtmlLibrary from 'sanitize-html';
import { type SanitizeHtmlOptions, sanitizeMessageHtml } from './sanitize.js';

/**
 * `ticket_messages.body_text`: the same message as plain text.
 *
 * It is a stored column rather than something derived at read time because
 * three things read it and none of them can render HTML — the notification
 * email's text part (M3-07), the ticket list's preview line, and the AI
 * retrieval path, which must never be handed markup (DOMAIN-RULES §9).
 */

/**
 * Where a line ends. Applied to markup that has *already* been through the
 * sanitiser, so the tag set is the allowlist and nothing else: this is a
 * transformation of known-safe text, not a way of parsing hostile HTML.
 */
const LINE_BREAKS = /<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6]|blockquote|pre|table)\s*>|<hr\s*\/?>/gi;

/**
 * The library escapes `&`, `<`, `>` and `"` on the way out, because its output
 * is normally HTML. Here the output is text, so those four go back to the
 * characters the message actually contained. Every other entity in the source
 * was already decoded by the parser and emitted as its character.
 *
 * The order matters: `&amp;` has to be last, or `&amp;lt;` — a message that
 * literally says `&lt;` — would come out as `<`.
 */
const ESCAPES: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

/** Runs of spaces and tabs collapse; a non-breaking space is one of them. */
const HORIZONTAL_WHITESPACE = /[^\S\r\n]+/g;
/** Three or more newlines are one blank line. Email quoting produces a lot of them. */
const BLANK_LINES = /\n{3,}/g;

export const htmlToText = (html: string): string => {
  const withBreaks = html.replace(LINE_BREAKS, '\n');
  const stripped = sanitizeHtmlLibrary(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    // Without this, `<style>` and `<script>` content survives as text.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title'],
  });

  const decoded = ESCAPES.reduce(
    (text, [pattern, character]) => text.replace(pattern, character),
    stripped,
  );

  return decoded
    .replace(HORIZONTAL_WHITESPACE, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(BLANK_LINES, '\n\n')
    .trim();
};

export interface SanitizedBody {
  /** Safe to render. What goes into `ticket_messages.body_html`. */
  readonly html: string;
  /** The same message as text. What goes into `ticket_messages.body_text`. */
  readonly text: string;
}

/**
 * The one call a message-writing path makes. Sanitising and extracting
 * together, so the text can never be derived from a body the sanitiser has not
 * seen — which is the shape of every "we stored the raw one too" bug.
 */
export const sanitizeMessageBody = (html: string, options?: SanitizeHtmlOptions): SanitizedBody => {
  const safe = sanitizeMessageHtml(html, options);

  return { html: safe, text: htmlToText(safe) };
};
