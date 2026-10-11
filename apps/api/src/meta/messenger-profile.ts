// M10-04 stand-in for M10-05's enqueueMetaProfile; the orchestrator keeps M10-05's at merge.
import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { metaPlatformSchema } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * The outbox event that asks for a customer's name (ADR 0025: the webhook never
 * calls Graph). The `meta.profile_fetch` job reads it from Graph once per
 * conversation and writes it on the conversation and, while it is still empty,
 * on the contact.
 */

export const metaProfileEventSchema = z.object({
  conversationId: z.uuid(),
  accountId: z.uuid(),
  platform: metaPlatformSchema,
});
export type MetaProfileEvent = z.infer<typeof metaProfileEventSchema>;

export const enqueueMetaProfile = async (
  tx: DbTransaction,
  brandId: string,
  profile: MetaProfileEvent,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: 'meta.profile',
    payload: metaProfileEventSchema.parse(profile),
  });
