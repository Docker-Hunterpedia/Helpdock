import {
  type InboundEnvelope,
  MissingSenderError,
  toEmailInboundMessage,
} from '@helpdock/channels';
import { type Db, type DbTransaction, mailboxes, ticketMessages } from '@helpdock/db';
import type { InboundParseOutcome } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { withSystemJob } from '../../tenant/system-job.js';
import { isSenderBlocked } from '../../ticketing/sender-gate.js';
import { isUniqueViolation } from '../pg-errors.js';
import type { StorageAttachmentSink } from './attachment-sink.js';
import type { ConversationRouter, RouteOutcome } from './conversation-router.js';

/**
 * One inbound email into one brand (M2-02, M2-03): the part IMAP and every
 * inbound-parse provider share, after each has found the mailbox.
 *
 * In one system transaction for the mailbox's brand (DOMAIN-RULES §1.4):
 *
 * 1. **Dedupe** by `Message-ID`: a redelivered message — the same IMAP message
 *    after a crash, a webhook the provider retried — is recognised and
 *    answered `duplicate` (§6). The unique index on `ticket_messages` is the
 *    guarantee; this read only makes the common case quiet.
 * 2. **Automated senders** (§4.3) are logged and dropped unless the mailbox
 *    allow-lists them.
 * 3. **Blocked senders** (M1-11) are dropped and counted.
 * 4. The rest goes to the {@link ConversationRouter}.
 *
 * A dropped message still counts as delivered: the poller moves past it and
 * the provider gets its 200, because retrying would only drop it again.
 */

export type InboundResult =
  | { readonly outcome: 'accepted'; readonly route: RouteOutcome }
  | { readonly outcome: 'duplicate' | 'ignored'; readonly reason: string };

export interface InboundLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface InboundEmailServiceOptions {
  readonly db: Db;
  readonly router: ConversationRouter;
  /** A fresh sink per message, so a rolled-back message's uploads are its own to remove. */
  readonly sink: () => StorageAttachmentSink;
  readonly removeObject: (key: string) => Promise<void>;
  readonly log: InboundLog;
  readonly now?: () => Date;
}

export class InboundEmailService {
  readonly #options: InboundEmailServiceOptions;
  readonly #now: () => Date;

  constructor(options: InboundEmailServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async receive(
    target: { readonly brandId: string; readonly mailboxId: string },
    envelope: InboundEnvelope,
  ): Promise<InboundResult> {
    const now = this.#now();
    let message: ReturnType<typeof toEmailInboundMessage>;
    try {
      message = toEmailInboundMessage(envelope, now);
    } catch (error) {
      if (error instanceof MissingSenderError) {
        this.#options.log.info(
          { mailboxId: target.mailboxId },
          'inbound email has no sender; dropped',
        );
        return { outcome: 'ignored', reason: 'no-sender' };
      }
      throw error;
    }

    const sink = this.#options.sink();
    try {
      return await withSystemJob(
        this.#options.db,
        target.brandId,
        `email:${target.mailboxId}`,
        async (tx): Promise<InboundResult> => {
          const mailbox = await this.#mailbox(tx, target.mailboxId);
          if (mailbox === undefined) {
            return { outcome: 'ignored', reason: 'mailbox-gone' };
          }

          if (await this.#seen(tx, target.brandId, message.externalId)) {
            return { outcome: 'duplicate', reason: 'message-id' };
          }

          const sender = message.from.value.toLowerCase();
          const automated = message.email.automated;
          if (automated !== null && !mailbox.automatedAllowlist.includes(sender)) {
            this.#options.log.info(
              { mailboxId: mailbox.id, reason: automated, messageId: message.externalId },
              'automated email not turned into a ticket (DOMAIN-RULES §4.3)',
            );
            await this.#touch(tx, mailbox.id, now);
            return { outcome: 'ignored', reason: `automated:${automated}` };
          }

          const gate = await isSenderBlocked(
            tx,
            target.brandId,
            { kind: 'email', value: sender },
            { now },
          );
          if (gate.blocked) {
            await this.#touch(tx, mailbox.id, now);
            return { outcome: 'ignored', reason: 'blocked-sender' };
          }

          const route = await this.#options.router.route(
            {
              tx,
              brandId: target.brandId,
              mailbox: {
                id: mailbox.id,
                departmentId: mailbox.departmentId,
                remoteImages: mailbox.remoteImages,
                authFailureIsSpam: mailbox.authFailureIsSpam,
              },
              ownAddresses: await this.#ownAddresses(tx),
              now,
            },
            message,
            sink,
          );
          await this.#touch(tx, mailbox.id, now);

          return { outcome: 'accepted', route };
        },
      );
    } catch (error) {
      await this.#discard(sink.uploaded);
      if (isUniqueViolation(error)) {
        // Two deliveries of one message raced past the read above; the loser
        // is the duplicate the index exists to refuse.
        return { outcome: 'duplicate', reason: 'message-id' };
      }
      throw error;
    }
  }

  async #mailbox(tx: DbTransaction, id: string) {
    const rows = await tx.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    return rows[0];
  }

  async #seen(tx: DbTransaction, brandId: string, externalId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.brandId, brandId),
          eq(ticketMessages.channel, 'email'),
          eq(ticketMessages.externalMessageId, externalId),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  async #ownAddresses(tx: DbTransaction): Promise<Set<string>> {
    const rows = await tx.select({ address: mailboxes.address }).from(mailboxes);
    return new Set(rows.map((row) => row.address));
  }

  async #touch(tx: DbTransaction, mailboxId: string, now: Date): Promise<void> {
    await tx.update(mailboxes).set({ lastReceivedAt: now }).where(eq(mailboxes.id, mailboxId));
  }

  async #discard(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.#options.removeObject(key);
      } catch (error) {
        this.#options.log.warn(
          { key, err: error },
          'could not remove an orphaned inbound attachment',
        );
      }
    }
  }
}

/** Maps an {@link InboundResult} to the word the inbound-parse card shows. */
export const outcomeOf = (result: InboundResult): InboundParseOutcome => result.outcome;
