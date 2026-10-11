import { splitMetaText } from '@helpdock/channels';
import type {
  Attachment,
  MetaAccount,
  MetaConversation,
  MetaDelivery as MetaDeliveryRow,
} from '@helpdock/db';
import type {
  MetaDeliveryView,
  MetaLeftOut,
  MetaPlatform,
  MetaTicketContext,
} from '@helpdock/schemas';
import { customerIsTold, planOutgoingFile } from './meta-attachments.js';
import { type ReplyWindow, replyWindowView } from './meta-window.js';

/**
 * A delivery and a conversation as the ticket view reads them (M10-06). Nothing
 * here reaches Graph, and no token is in any row it is given.
 */

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** What a delivery's row cannot say by itself: how many messages it is, and which files stayed out. */
export interface DeliveryFacts {
  readonly partsTotal: number;
  readonly leftOut: readonly MetaLeftOut[];
}

/**
 * The reply as parts: its text cut at the platform's limit, then one message per
 * attachment (`meta-send.job.ts` sends exactly these). A file the platform will
 * not take is still a part, because the job records it as one, so
 * `parts_sent` and this total are counted the same way.
 */
export const deliveryFacts = (
  platform: MetaPlatform,
  bodyText: string,
  files: readonly Pick<Attachment, 'id' | 'originalName' | 'status' | 'kind' | 'variants'>[],
): DeliveryFacts => {
  const leftOut: MetaLeftOut[] = [];
  for (const file of files) {
    const plan = planOutgoingFile(file, platform);
    if (plan.kind === 'skip' && customerIsTold(plan.reason)) {
      leftOut.push({ attachmentId: file.id, name: file.originalName, reason: plan.reason });
    }
  }

  return { partsTotal: splitMetaText(bodyText, platform).length + files.length, leftOut };
};

export const toMetaDelivery = (row: MetaDeliveryRow, facts: DeliveryFacts): MetaDeliveryView => ({
  id: row.id,
  ticketMessageId: row.ticketMessageId,
  status: row.status,
  partsSent: row.partsSent,
  partsTotal: facts.partsTotal,
  leftOut: [...facts.leftOut],
  attempts: row.attempts,
  lastError: row.lastError,
  errorCode: row.errorCode,
  tag: row.tag,
  templateName: row.templateName,
  sentAt: iso(row.sentAt),
  deliveredAt: iso(row.deliveredAt),
  readAt: iso(row.readAt),
  failedAt: iso(row.failedAt),
});

/**
 * Who the conversation is with and through which account, with the window for a
 * person writing now. Optional facts are left out rather than sent as null, as
 * the schema has them.
 */
export const toMetaTicketContext = ({
  account,
  conversation,
  window,
}: {
  readonly account: MetaAccount;
  readonly conversation: MetaConversation;
  readonly window: ReplyWindow;
}): MetaTicketContext => ({
  account: {
    id: account.id,
    platform: account.platform,
    externalId: account.externalId,
    displayName: account.displayName,
    ...(account.username === null ? {} : { username: account.username }),
    ...(account.displayPhone === null ? {} : { displayPhone: account.displayPhone }),
  },
  customerId: conversation.customerId,
  // `wa_id` is only ever set from Meta's own webhook, which is what makes the
  // number a verified one (DOMAIN-RULES §4.7); a number an agent typed lives in
  // `contact_identities` and is never read here.
  ...(conversation.waId === null ? {} : { phone: `+${conversation.waId}` }),
  phoneVerified: account.platform === 'whatsapp' && conversation.waId !== null,
  ...(conversation.profileName === null ? {} : { profileName: conversation.profileName }),
  ...(conversation.username === null ? {} : { username: conversation.username }),
  window: replyWindowView(window),
});
