import { importEntitySchema } from '@helpdock/schemas';
import { z } from 'zod';

export const importConnectorLogSchema = z.strictObject({
  level: z.enum(['info', 'warning', 'error']),
  message: z.enum([
    'import.record-unavailable',
    'import.attachment.expired',
    'import.mapping.unknown-value',
    'import.field.unsupported-semantics',
    'import.csat.timestamp-inferred',
    'import.csat.scale-normalized',
    'import.csat.rating-unmapped',
    'import.knowledge.readership-restricted',
    'import.freshdesk.timestamp-window-exhausted',
    'import.zoho.timestamp-window-exhausted',
    'import.zoho.archive-window-exhausted',
    'import.message.author-unavailable',
    'import.message.identity-unavailable',
    'import.message.unsent-thread',
    'import.zoho.full-content-unsupported',
    'import.zoho.full-content-format-inferred',
    'import.zoho.original-mail-unavailable',
    'import.zoho.mail-date-unparsed',
    'import.zoho.article-files-envelope-inferred',
    'import.zoho.history-page-changed',
    'import.zoho.description-fallback',
    'import.profile.inactive-source',
    'import.knowledge.locale-unsupported',
    'import.article.asset-unavailable',
  ]),
  entity: importEntitySchema.optional(),
  externalId: z.string().max(200).optional(),
});
