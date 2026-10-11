import { createI18n, type Locale } from '@helpdock/i18n';
import { META_ATTACHMENT_LIMITS, type MetaPlatform } from '@helpdock/schemas';
import type { MetaSkipReason } from './meta-attachments.js';

/**
 * What the api says to a WhatsApp, Messenger or Instagram customer on its own
 * account (M10-06), in their language: the `meta` catalog, from one i18next
 * instance for the process, as `telegram-text.ts` has for the bot.
 */

const i18n = createI18n();

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
  const t = i18n.getFixedT(input.locale, 'meta');
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
