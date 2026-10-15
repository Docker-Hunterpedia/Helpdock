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
    'import.knowledge.readership-restricted',
  ]),
  entity: importEntitySchema.optional(),
  externalId: z.string().max(200).optional(),
});
