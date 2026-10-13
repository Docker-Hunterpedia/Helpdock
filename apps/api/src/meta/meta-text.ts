import type { MetaInboundLabels } from '@helpdock/channels';
import { createI18n, type Locale } from '@helpdock/i18n';
import { META_ATTACHMENT_LIMITS, type MetaPlatform } from '@helpdock/schemas';
import type { MetaSkipReason } from './meta-attachments.js';

/**
 * The `meta` catalog, in the customer's language: what the api writes into a
 * WhatsApp, Messenger or Instagram ticket's thread (the word for a shared
 * location, the line for a story, the system lines for something it cannot
 * show; M10-03 to M10-05) and what it says to the customer on the brand's own
 * account (the line for a file that was left out; M10-06).
 *
 * One i18next instance for the process, for the reason `telegram-text.ts`
 * gives: the catalogs are bundled, so a fixed `t` per locale is all a message
 * needs. Read by the customer's language rather than the agent's, because the
 * words are filed with the message and read by whoever opens the ticket.
 */

const i18n = createI18n();

/** `t` over the `meta` catalog. */
export const metaText = (locale: Locale) => i18n.getFixedT(locale, 'meta');

/** The words `toWhatsAppInboundMessage` (and its two siblings) file a message with. */
export const metaInboundLabels = (locale: Locale): MetaInboundLabels => {
  const t = metaText(locale);

  return {
    location: t('thread.location'),
    contact: t('thread.contact'),
    story: { reply: t('thread.story.reply'), mention: t('thread.story.mention') },
  };
};

/** A line of a Meta ticket's thread that no person wrote. */
export type MetaSystemLine =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unsent' }
  | { readonly kind: 'reaction'; readonly emoji: string | null }
  /** A reaction whose emoji Meta did not name (Messenger). */
  | { readonly kind: 'reactionPlain' }
  /** A message the customer edited (Messenger), with the words it now has. */
  | { readonly kind: 'edited'; readonly text: string }
  | { readonly kind: 'numberChanged'; readonly from: string; readonly to: string };

/** The words of a system line in a locale, as a `ticket_messages.body_text`. */
export const metaSystemLine = (locale: Locale, line: MetaSystemLine): string => {
  const t = metaText(locale);
  switch (line.kind) {
    case 'unsupported':
      return t('thread.unsupported');
    case 'unsent':
      return t('thread.unsent');
    case 'reaction':
      return line.emoji === null
        ? t('thread.reactionRemoved')
        : t('thread.reaction', { emoji: line.emoji });
    case 'reactionPlain':
      return t('thread.reactionPlain');
    case 'edited':
      return t('thread.edited', { text: line.text });
    case 'numberChanged':
      return t('thread.numberChanged', { from: line.from, to: line.to });
  }
};

/** First strong isolate and pop: a file name in Latin script stays in one piece inside Arabic text. */
const FIRST_STRONG_ISOLATE = '⁨';
const POP_DIRECTIONAL_ISOLATE = '⁩';

/**
 * "One file could not be sent here: warranty-terms.docx. Instagram only takes
 * PDF files, so we will send it another way." The message that takes the place
 * of a file the platform would not accept, so the customer knows to ask for it
 * (`Meta/Chat-EN`, `Meta/Chat-AR`). Plain text: the platforms draw no markup, so
 * the name is isolated with the Unicode bidirectional marks `<bdi>` stands for.
 */
export const fileLeftOutText = (input: {
  readonly locale: Locale;
  readonly platform: MetaPlatform;
  readonly name: string;
  readonly reason: Exclude<MetaSkipReason, 'not-sendable'>;
  /** A file, not an image or a clip: what the platform's file list is about. */
  readonly isFile: boolean;
}): string => {
  const t = metaText(input.locale);
  const key =
    input.reason === 'too-large'
      ? 'reply.fileTooLarge'
      : input.isFile && META_ATTACHMENT_LIMITS[input.platform].fileTypes !== null
        ? 'reply.fileLeftOut'
        : 'reply.fileUnsupported';

  return t(key, {
    name: `${FIRST_STRONG_ISOLATE}${input.name}${POP_DIRECTIONAL_ISOLATE}`,
    platform: t(`reply.platform.${input.platform}`),
  });
};
