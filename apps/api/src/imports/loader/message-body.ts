import { sanitizeMessageBody } from '@helpdock/channels';
import type { ImportMessage } from '@helpdock/schemas';

/** Preview and storage must render the same sanitized body, including literal plain-text markup. */
export function importedMessageBody(message: Pick<ImportMessage, 'bodyHtml' | 'bodyText'>) {
  if (message.bodyHtml !== undefined) return sanitizeMessageBody(message.bodyHtml);
  const escaped = (message.bodyText ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return sanitizeMessageBody(`<p>${escaped.replaceAll(/\r?\n/g, '<br>')}</p>`);
}
