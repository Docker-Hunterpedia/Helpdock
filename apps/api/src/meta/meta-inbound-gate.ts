import { metaIdentityValue } from '@helpdock/channels';
import {
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  ticketMessages,
} from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { isSenderBlocked } from '../ticketing/sender-gate.js';

/**
 * The two questions asked of a customer's message before it becomes anything
 * (M10-02), once for all three platforms so the inbound services cannot come
 * to ask them three ways.
 */

/**
 * Whether this message was filed already (DOMAIN-RULES §6): `wamid.…` and `mid`
 * are unique across Meta, and `ticket_messages.external_message_id` is unique
 * per brand and channel, which for a Meta ticket is the platform.
 */
export const metaMessageSeen = async (
  tx: DbTransaction,
  brandId: string,
  platform: MetaPlatform,
  messageId: string,
): Promise<boolean> => {
  const rows = await tx
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.brandId, brandId),
        eq(ticketMessages.channel, platform),
        eq(ticketMessages.externalMessageId, messageId),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

/**
 * The block-list entry a Meta customer is: the value their contact's identity
 * has (`metaIdentityValue`), under the platform's own kind. "Block sender" on a
 * Meta ticket blocks what `senderOf` finds in the contact's identities, which
 * is this, and the inbound gate looks the same pair up, so the two cannot come
 * apart (the join is `meta-inbound-gate.test.ts` and the Block sender case of
 * `meta.integration.test.ts`).
 */
export const metaBlockEntry = (
  account: Pick<MetaAccountRow, 'platform' | 'externalId'>,
  customerId: string,
): { readonly kind: MetaPlatform; readonly value: string } => ({
  kind: account.platform,
  value: metaIdentityValue(account.platform, account.externalId, customerId),
});

/**
 * Whether the block list holds this customer (M1-11). A drop is counted on the
 * block row in the caller's transaction.
 */
export const metaSenderBlocked = async (
  tx: DbTransaction,
  account: Pick<MetaAccountRow, 'brandId' | 'platform' | 'externalId'>,
  customerId: string,
  now: Date,
): Promise<boolean> => {
  const gate = await isSenderBlocked(tx, account.brandId, metaBlockEntry(account, customerId), {
    now,
  });
  return gate.blocked;
};
