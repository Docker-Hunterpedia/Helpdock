import { escapeHtml } from '@helpdock/channels';
import type { Locale } from '@helpdock/i18n';
import { customerCopy } from './email-copy.js';

/**
 * M14-31. The message a targeted reply answers, as it is quoted under the
 * reply: a line "On <date> at <time>, <name> wrote:" in the customer's language
 * and the message's plain text as a blockquote (`> ` lines in the text part).
 *
 * Built when the mail is sent from the stored target, never stored with the
 * reply, so the thread, search, the assistant and webhooks only ever see what
 * the agent wrote. The customer's text is escaped, never rendered, and capped.
 */

export const QUOTE_MAX_CHARS = 2000;

export interface QuotedMessage {
  /** Who wrote it; null or blank falls back to "the customer". */
  readonly name: string | null;
  readonly at: Date;
  /** The message's plain text. */
  readonly text: string;
}

const COLOURS = { rule: '#E3DFD6', text: '#5C564C' } as const;

const INTL_LOCALE: Readonly<Record<Locale, string>> = {
  en: 'en-GB',
  // Latin digits, as the rest of the customer email writes them.
  ar: 'ar-u-nu-latn',
};

/** One printable line: no control characters, no newlines, bounded. */
const oneLine = (value: string): string =>
  value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
    .slice(0, 200);

/** The text with its line endings normalised and cut at the cap, on a code point. */
export const capQuoteText = (text: string): string => {
  const normalised = text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim();
  const points = Array.from(normalised);

  return points.length <= QUOTE_MAX_CHARS
    ? normalised
    : `${points.slice(0, QUOTE_MAX_CHARS).join('').trimEnd()}…`;
};

export const buildReplyQuote = (
  locale: Locale,
  brandName: string,
  quoted: QuotedMessage,
): { html: string; text: string } => {
  const copy = customerCopy(locale, brandName);
  const intlLocale = INTL_LOCALE[locale];
  const date = new Intl.DateTimeFormat(intlLocale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(quoted.at);
  const time = new Intl.DateTimeFormat(intlLocale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(quoted.at);
  const name = oneLine(quoted.name ?? '') || copy.quoteAnonymous;
  const intro = copy.quoteIntro(date, time, name);
  const lines = capQuoteText(quoted.text).split('\n');

  return {
    html: `<p style="margin:24px 0 8px 0;font-size:13px;line-height:20px;color:${COLOURS.text}">${escapeHtml(intro)}</p><blockquote style="margin:0;padding:0 12px;border-inline-start:3px solid ${COLOURS.rule};font-size:14px;line-height:20px;color:${COLOURS.text}">${lines.map(escapeHtml).join('<br>')}</blockquote>`,
    text: [intro, ...lines.map((line) => `> ${line}`.trimEnd())].join('\n'),
  };
};
