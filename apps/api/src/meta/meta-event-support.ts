import type { MetaEvent, MetaInboundMessage } from '@helpdock/channels';
import type {
  DbTransaction,
  MetaAccount as MetaAccountRow,
  MetaConversation as MetaConversationRow,
} from '@helpdock/db';
import { z } from 'zod';
import { ContactFailure } from '../contacts/contact-failure.js';
import type { MetaRepository } from './meta.repository.js';
import { enqueueMetaProfile } from './meta-events.js';
import type {
  MetaDropReason,
  MetaEventContext,
  MetaEventOutcome,
  MetaInboundLog,
} from './meta-inbound.service.js';
import { wantsProfile } from './meta-profile.js';
import type {
  MetaAttachmentSink,
  MetaConversationRouter,
  MetaRouteContext,
  MetaRouteOptions,
  MetaRouteOutcome,
} from './meta-router.js';

/**
 * What the three platforms' inbound services decide the same way (M10-03 to
 * M10-05), written once so a name, a clamp or a rule means one thing in every
 * route report and none of them can drift.
 */

export const handled: MetaEventOutcome = { outcome: 'handled' };

export const duplicate: MetaEventOutcome = { outcome: 'duplicate' };

export const ignored = (reason: MetaDropReason): MetaEventOutcome => ({
  outcome: 'ignored',
  reason,
});

/**
 * When an event happened, for the reply window and the delivery's timestamps:
 * Meta's clock, never later than Helpdock's own, so a skewed or forged
 * timestamp cannot hold a window open into the future.
 */
export const instantOf = (reported: Date | null, now: Date): Date =>
  reported === null || reported > now ? now : reported;

/** Where a message came to, in the shape the router takes. */
export const routeContextOf = ({ tx, account, now }: MetaEventContext): MetaRouteContext => ({
  tx,
  brandId: account.brandId,
  account: {
    id: account.id,
    departmentId: account.departmentId,
    platform: account.platform,
    externalId: account.externalId,
  },
  now,
});

/** The parts of a platform's service the shared steps below need. */
export interface MetaInboundParts {
  readonly router: MetaConversationRouter;
  readonly sink: MetaAttachmentSink;
  readonly log: MetaInboundLog;
}

/**
 * The router's filing of a customer's message, or undefined for a customer id
 * this install cannot hold as an identifier. Meta would redeliver such a
 * message for days to no purpose, so it is dropped and counted rather than
 * allowed to fail every event of the account's batch.
 */
export const routeOrDrop = async (
  { router, sink, log }: MetaInboundParts,
  context: MetaEventContext,
  message: MetaInboundMessage,
  options?: MetaRouteOptions,
): Promise<MetaRouteOutcome | undefined> => {
  try {
    return await router.route(routeContextOf(context), message, sink, options);
  } catch (error) {
    if (!(error instanceof ContactFailure)) {
      throw error;
    }
    log.warn(
      { accountId: context.account.id, reason: error.reason },
      `a ${context.account.platform} customer id was refused as an identifier; the message is dropped`,
    );
    return undefined;
  }
};

/** What a platform that sends echoes needs to recognise Helpdock's own. */
export interface MetaEchoParts {
  /** The install's `meta.appId`, empty when none is set. */
  readonly appId: () => Promise<string>;
  readonly repository: Pick<MetaRepository, 'delivery'>;
  readonly log: MetaInboundLog;
}

/**
 * A message the account sent, echoed back. Helpdock's own are in the thread
 * already as the reply an agent wrote, and carry the app's id or the delivery
 * id it set as `metadata`: dropped without a word. Any other was typed in
 * Meta Business Suite or the Instagram app, which M10 does not import (the
 * milestone's accepted gaps): dropped and counted, so an operator can see it
 * happens.
 */
export const dropEcho = async (
  { tx, account }: MetaEventContext,
  event: Extract<MetaEvent, { kind: 'echo' }>,
  { appId, repository, log }: MetaEchoParts,
): Promise<MetaEventOutcome> => {
  const ours = await appId();
  const own =
    (ours !== '' && event.appId === ours) ||
    (await isOurDelivery(repository, tx, account.id, event.metadata));
  if (own) {
    return ignored('own-echo');
  }
  log.info(
    { accountId: account.id, platform: account.platform },
    `${account.platform} echo of a message Helpdock did not send; dropped`,
  );
  return ignored('foreign-echo');
};

const isOurDelivery = async (
  repository: Pick<MetaRepository, 'delivery'>,
  tx: DbTransaction,
  accountId: string,
  metadata: string | null,
): Promise<boolean> => {
  const id = z.uuid().safeParse(metadata);
  if (!id.success) {
    return false;
  }
  const delivery = await repository.delivery(tx, id.data);

  return delivery?.accountId === accountId;
};

/**
 * Meta's message carries no name on Messenger or Instagram. A customer nobody
 * has named, and Graph has not been asked about, gets one lookup, raised here
 * and run by a job: the webhook never calls Graph (ADR 0025, 6). An account
 * whose token is dead is not asked, since the answer would be recorded as
 * "asked" and the name never looked for again.
 */
export const askForProfile = async (
  tx: DbTransaction,
  account: Pick<MetaAccountRow, 'id' | 'brandId' | 'status'>,
  platform: 'messenger' | 'instagram',
  conversationId: string,
  before: MetaConversationRow | undefined,
): Promise<void> => {
  if (account.status === 'connected' && wantsProfile(before)) {
    await enqueueMetaProfile(tx, account.brandId, {
      conversationId,
      accountId: account.id,
      platform,
    });
  }
};

/**
 * What an event of a kind no platform service files becomes: a postback or a
 * referral is counted under its own name, `ignored` carries the classifier's
 * reason, and anything else is another platform's vocabulary (a Messenger
 * watermark on WhatsApp, a WhatsApp status on a Page), which is logged.
 */
export const otherEvent = (
  log: MetaInboundLog,
  { account }: Pick<MetaEventContext, 'account'>,
  event: MetaEvent,
): MetaEventOutcome => {
  switch (event.kind) {
    case 'ignored':
      return ignored(event.reason);
    case 'postback':
    case 'referral':
      return ignored(event.kind);
    default:
      log.warn(
        { accountId: account.id, kind: event.kind, platform: event.platform },
        `${account.platform} received an event of another platform; dropped`,
      );
      return ignored('wrong-platform');
  }
};
