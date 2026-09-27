import { escapeHtml } from '@helpdock/channels';
import { createI18n, type Locale } from '@helpdock/i18n';

/**
 * A visitor types plain text. The thread stores sanitised HTML beside the
 * text for every message (REQUIREMENTS §5.1), so the widget's text is escaped
 * and split into paragraphs here — it is never parsed as markup.
 */

export const plainTextToHtml = (text: string): string =>
  text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${paragraph.split(/\r?\n/).map(escapeHtml).join('<br>')}</p>`)
    .join('');

/** How much of the first message becomes the subject agents see in the queue. */
export const SUBJECT_MAX = 80;

/**
 * The first line of the first message, cut at a word near 80 characters; a
 * message that is only attachments or whitespace gets "Chat conversation" in
 * the brand's language.
 */
export const subjectFrom = (text: string, locale: Locale): string => {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (line === '') {
    return createI18n({ lng: locale }).getFixedT(locale, 'ticket')('system.chatSubject');
  }
  if (line.length <= SUBJECT_MAX) {
    return line;
  }

  const cut = line.slice(0, SUBJECT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > SUBJECT_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
