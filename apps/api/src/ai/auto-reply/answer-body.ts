import { escapeHtml, type SanitizedBody, sanitizeMessageBody } from '@helpdock/channels';
import { createI18n, type Locale } from '@helpdock/i18n';
import { plainTextToHtml } from '../../widget/plain-text.js';
import type { StoredCitation } from './ai-meta.js';

/**
 * The body an assistant message is stored with, which is what email and
 * Telegram send (M7-06): the answer, then its public sources by number so a
 * reader without the widget can still follow `[1]`. Built as HTML and run
 * through the message sanitiser like every other body, which also derives the
 * text.
 */
export const answerBody = (
  answer: string,
  citations: readonly StoredCitation[],
  locale: Locale,
): SanitizedBody => {
  const shown = citations.filter((citation) => citation.visibility === 'public');
  if (shown.length === 0) {
    return sanitizeMessageBody(plainTextToHtml(answer));
  }
  const t = createI18n({ lng: locale }).getFixedT(locale, 'ticket');
  const sources = shown.map(({ marker, title, url }) => {
    const label = escapeHtml(title === '' ? `[${String(marker)}]` : title);
    const linked = url === null ? label : `<a href="${escapeHtml(url)}">${label}</a>`;
    return `<p>[${String(marker)}] ${linked}</p>`;
  });
  return sanitizeMessageBody(
    `${plainTextToHtml(answer)}<p>${escapeHtml(t('system.aiSources'))}</p>${sources.join('')}`,
  );
};
