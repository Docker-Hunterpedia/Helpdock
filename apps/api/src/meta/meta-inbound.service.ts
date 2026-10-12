import type { MetaEvent, MetaIgnoredReason, MetaRoute } from '@helpdock/channels';
import type { Db, DbTransaction, MetaAccount as MetaAccountRow } from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';
import { isUniqueViolation } from '../channels/pg-errors.js';
import { withSystemJob } from '../tenant/system-job.js';
import type { AccountLocator, MetaRepository } from './meta.repository.js';
import { metaMessageSeen, metaSenderBlocked } from './meta-inbound-gate.js';

/**
 * One account's events from one webhook, filed into its brand (M10-02, ADR
 * 0025, 6): the part that is the same for WhatsApp, Messenger and Instagram,
 * after the webhook has verified the signature and found the account.
 *
 * | The event is | What happens |
 * |---|---|
 * | a customer's message already filed | `duplicate`; the handler never sees it |
 * | anything a customer caused (a message, a reaction, an edit, an unsent or unsupported message) from a blocked sender | `ignored`, counted on the block row |
 * | any other event, or one that passed both | the platform's {@link PlatformInboundService} decides |
 *
 * **One system transaction for the account's brand** holds every event of the
 * route, so a customer who writes three times in one batch is filed in order
 * and a failure rolls back the lot, which Meta redelivers and the dedupe above
 * makes safe. **Each event runs in a savepoint**, so the race of two deliveries
 * of one batch — both pass the check, one insert waits for the other and fails
 * on the unique index — costs the loser that event alone and is answered as a
 * duplicate rather than a failure.
 *
 * Nothing here calls Meta. What an event causes outside the database (a media
 * fetch, a reply) is an outbox row written in the same transaction by the
 * handler.
 */

/**
 * Why an event was dropped, in one vocabulary for all three platforms, so a
 * name in the route report means one thing whichever service wrote it.
 */
export type MetaDropReason =
  /** What the classifier already refused (a field, a standby event, an empty message). */
  | MetaIgnoredReason
  | 'account-gone'
  | 'blocked-sender'
  /** The customer's id, or a number it carried, cannot be held as an identifier. */
  | 'invalid-customer-id'
  | 'invalid-number'
  /** A message the account sent: Helpdock's own, or typed outside it. */
  | 'own-echo'
  | 'foreign-echo'
  | 'no-conversation'
  | 'unknown-conversation'
  /** The ticket is closed, spam or was never opened: nowhere to write a line. */
  | 'no-open-ticket'
  /** The message a reaction, an edit or an unsend is about was never filed. */
  | 'unknown-message'
  | 'no-delivery-to-advance'
  | 'no-delivery-to-fail'
  /** Helpdock recorded Meta's acceptance when it sent; the status adds nothing. */
  | 'status-sent'
  | 'empty-receipt'
  | 'empty-edit'
  | 'policy-enforcement'
  | 'postback'
  | 'referral'
  /** An event of another platform's vocabulary reached this platform's service. */
  | 'wrong-platform';

/** What became of one event. */
export type MetaEventOutcome =
  /** The handler did what the event's kind calls for. */
  | { readonly outcome: 'handled' }
  /** The message was filed before: by an earlier delivery of this batch, or a concurrent one. */
  | { readonly outcome: 'duplicate' }
  /** Dropped on purpose, with the reason. */
  | { readonly outcome: 'ignored'; readonly reason: MetaDropReason };

/** What a handler is given, inside the route's transaction (already in a savepoint). */
export interface MetaEventContext {
  readonly tx: DbTransaction;
  readonly account: MetaAccountRow;
  readonly now: Date;
}

/**
 * One platform's inbound service: WhatsApp's (M10-03), Messenger's (M10-04) or
 * Instagram's (M10-05). `handle` is called once per event of the platform's
 * accounts, in the order Meta sent them. It throws to refuse the whole route
 * (the transaction rolls back and Meta redelivers); a customer's message has
 * been checked against the dedupe key, and anything a customer caused against
 * the block list, before it gets here.
 */
export interface PlatformInboundService {
  handle(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome>;
}

export type MetaInboundHandlers = Readonly<Record<MetaPlatform, PlatformInboundService>>;

export interface MetaInboundLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** What {@link MetaInboundService.receive} did with one account's events. */
export interface MetaRouteResult {
  readonly accountId: string;
  readonly brandId: string;
  readonly platform: MetaPlatform;
  /** One outcome per event, in the order the route held them. */
  readonly events: readonly MetaEventOutcome[];
}

export interface MetaInboundServiceOptions {
  readonly db: Db;
  readonly repository: MetaRepository;
  readonly handlers: MetaInboundHandlers;
  readonly log: MetaInboundLog;
  readonly now?: () => Date;
}

export class MetaInboundService {
  readonly #options: MetaInboundServiceOptions;
  readonly #now: () => Date;

  constructor(options: MetaInboundServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Files one account's events. Throws when the transaction fails, after
   * recording the failure on the account (`last_error`) outside it.
   */
  async receive(locator: AccountLocator, route: MetaRoute): Promise<MetaRouteResult> {
    const now = this.#now();
    try {
      const events = await withSystemJob(
        this.#options.db,
        locator.brandId,
        'meta.webhook',
        async (tx): Promise<MetaEventOutcome[]> => {
          const account = await this.#options.repository.account(tx, locator.id);
          if (account === undefined) {
            // Disconnected between the route being found and this transaction.
            return route.events.map(() => ({ outcome: 'ignored', reason: 'account-gone' }));
          }

          const outcomes: MetaEventOutcome[] = [];
          for (const event of route.events) {
            outcomes.push(await this.#file({ tx, account, now }, event));
          }
          await this.#options.repository.markEvent(tx, account.id, now);
          return outcomes;
        },
      );

      return {
        accountId: locator.id,
        brandId: locator.brandId,
        platform: locator.platform,
        events,
      };
    } catch (error) {
      await this.#recordError(locator, now, error);
      throw error;
    }
  }

  async #file(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    if (
      event.kind === 'message' &&
      (await metaMessageSeen(tx, account.brandId, account.platform, event.messageId))
    ) {
      return { outcome: 'duplicate' };
    }
    // Once for every platform and every kind of event a customer causes, so a
    // blocked customer cannot write a line into a thread or move the reply
    // window by a reaction, an edit or a message Helpdock cannot show.
    const sender = customerOf(event);
    if (sender !== null && (await metaSenderBlocked(tx, account, sender, now))) {
      return { outcome: 'ignored', reason: 'blocked-sender' };
    }

    try {
      return await tx.transaction((savepoint) =>
        this.#options.handlers[account.platform].handle({ ...context, tx: savepoint }, event),
      );
    } catch (error) {
      // Two deliveries of one batch raced past the check above, and the other
      // one's insert won. Only a message that is now there is a duplicate: a
      // unique violation of anything else is the handler's bug.
      if (
        event.kind === 'message' &&
        isUniqueViolation(error) &&
        (await metaMessageSeen(tx, account.brandId, account.platform, event.messageId))
      ) {
        return { outcome: 'duplicate' };
      }
      throw error;
    }
  }

  /** On the account's health line, from a transaction of its own: the route's rolled back. */
  async #recordError(locator: AccountLocator, now: Date, error: unknown): Promise<void> {
    try {
      await withSystemJob(this.#options.db, locator.brandId, 'meta.webhook', (tx) =>
        this.#options.repository.markError(tx, locator.id, describeFailure(error), now),
      );
    } catch (recordError) {
      this.#options.log.warn(
        { accountId: locator.id, err: recordError },
        'could not record meta account health',
      );
    }
  }
}

/**
 * The customer an event was caused by, or null for one nobody on the customer's
 * side caused: an echo, a receipt, a status, a policy notice.
 */
const customerOf = (event: MetaEvent): string | null => {
  switch (event.kind) {
    case 'message':
    case 'reaction':
    case 'edit':
    case 'deleted':
    case 'unsupported':
      return event.customerId;
    default:
      return null;
  }
};

/**
 * A failure's class and message for the account's health line, from the
 * innermost cause. The outer error of a failed query quotes the statement and
 * its parameters, which are a customer's words; the driver's own is not.
 * Never a token: Graph is not called on this path.
 */
export const describeFailure = (error: unknown): string => {
  let root: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const cause = root instanceof Error ? root.cause : undefined;
    if (cause === undefined || cause === null) {
      break;
    }
    root = cause;
  }

  return root instanceof Error ? `${root.name}: ${root.message}` : String(root);
};
