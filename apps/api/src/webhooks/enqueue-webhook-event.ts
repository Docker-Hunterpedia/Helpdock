import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { type AdditionalWebhookEvent, webhookSourcePayloadSchemas } from '@helpdock/schemas';
import type { z } from 'zod';

export const enqueueWebhookEvent = <E extends AdditionalWebhookEvent>(
  tx: DbTransaction,
  brandId: string,
  event: E,
  payload: z.input<(typeof webhookSourcePayloadSchemas)[E]>,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event,
    payload: webhookSourcePayloadSchemas[event].parse(payload),
  });
