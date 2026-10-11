import { resources } from '@helpdock/i18n';
import type { Attachment, TicketMessage } from '@helpdock/schemas';

/**
 * Reading what the inbound services of M10-03 to M10-05 filed into a Meta
 * thread back into what `Admin/Ticket-Meta` draws (M10-08): a quoted earlier
 * message as a leading quote, a story reply as a caption over a figure, a
 * sticker as an image, and the lines nobody wrote (a reaction, a message the
 * customer unsent, something Helpdock cannot show) with their own icon.
 *
 * The thread keeps no column for any of this. It is filed as words and files,
 * in the contact's language, by the shared `meta` catalog, so reading it back
 * is a match against that same catalog in both languages: a catalog change
 * moves the writer and this reader together, and the suite pins it.
 */

const LOCALES = ['en', 'ar'] as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A catalog sentence with `{{placeholders}}` as a pattern that matches any filling of them. */
const patternOf = (template: string): RegExp =>
  new RegExp(`^${escapeRegExp(template).replace(/\\\{\\\{\w+\\\}\\\}/g, '.+')}$`, 'u');

export type MetaLineKind = 'unsent' | 'reaction' | 'unsupported' | 'numberChanged';

/** The thread sentences of both languages, once. */
const LINES: readonly { readonly kind: MetaLineKind; readonly matches: RegExp }[] = LOCALES.flatMap(
  (locale) => {
    const thread = resources[locale].meta.thread;

    return [
      { kind: 'unsent' as const, matches: patternOf(thread.unsent) },
      { kind: 'unsupported' as const, matches: patternOf(thread.unsupported) },
      { kind: 'reaction' as const, matches: patternOf(thread.reaction) },
      { kind: 'reaction' as const, matches: patternOf(thread.reactionRemoved) },
      { kind: 'numberChanged' as const, matches: patternOf(thread.numberChanged) },
    ];
  },
);

/** Which kind of line a system message is, or null for any other system message. */
export const classifyMetaLine = (bodyText: string): MetaLineKind | null =>
  LINES.find((line) => line.matches.test(bodyText.trim()))?.kind ?? null;

/** The story labels ("Replied to your story") in both languages. */
const STORY_LABELS: readonly string[] = LOCALES.flatMap((locale) => {
  const { story } = resources[locale].meta.thread;
  return [story.reply, story.mention];
});

export interface StorySplit {
  /** The label the inbound service wrote: "Replied to your story". */
  readonly label: string;
  /** The message without it. */
  readonly html: string;
}

/** A story reply or mention opens with the catalog's label; the rest is what the customer wrote. */
export const splitStory = (message: Pick<TicketMessage, 'bodyText' | 'bodyHtml'>): StorySplit | undefined => {
  const label = STORY_LABELS.find((candidate) => message.bodyText.startsWith(candidate));
  if (label === undefined) {
    return undefined;
  }
  const opening = new RegExp(`^<p>\\s*${escapeRegExp(label)}\\s*(?:<br\\s*/?>)?\\s*`);
  const html = message.bodyHtml.replace(opening, '<p>').replace(/^<p>\s*<\/p>/, '');

  return { label, html };
};

export interface QuoteSplit {
  /** The quoted words, as the sanitiser left them (ADR 0007). */
  readonly quoteHtml: string;
  /** The quoted words as text, to find who said them. */
  readonly quoteText: string;
  /** The reply under the quote. */
  readonly html: string;
}

const textOf = (html: string): string =>
  new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? '';

/** A message that quotes an earlier one on this ticket starts with a `<blockquote>` (DOMAIN-RULES §4.8). */
export const splitQuote = (html: string): QuoteSplit | undefined => {
  const found = /^\s*<blockquote>([\s\S]*?)<\/blockquote>/.exec(html);
  if (found === null) {
    return undefined;
  }
  const quoteHtml = found[1] ?? '';

  return {
    quoteHtml,
    quoteText: textOf(quoteHtml),
    html: html.slice(found[0].length),
  };
};

/**
 * Who wrote the quoted message: the earlier message of the thread whose text
 * the quote begins. The api repeats up to 200 characters, with an ellipsis when
 * it cut, so the match is on that prefix; `undefined` when none matches, and
 * the quote is drawn without a name rather than with a guess.
 */
export const quotedMessage = (
  quoteText: string,
  before: readonly TicketMessage[],
): TicketMessage | undefined => {
  const prefix = quoteText.endsWith('…') ? quoteText.slice(0, -1) : quoteText;
  if (prefix === '') {
    return undefined;
  }

  return [...before]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind !== 'system' &&
        candidate.bodyText.replace(/\s+/g, ' ').trim().startsWith(prefix),
    );
};

/** A sticker is filed as an image named `sticker.webp` (`metaFileName`). */
export const isSticker = (attachment: Pick<Attachment, 'originalName'>): boolean =>
  /^sticker\./i.test(attachment.originalName);

/** Story media is filed as an image named `story.jpg` or `story-mention.jpg`. */
export const isStoryMedia = (attachment: Pick<Attachment, 'originalName'>): boolean =>
  /^story(?:-mention)?\./i.test(attachment.originalName);
