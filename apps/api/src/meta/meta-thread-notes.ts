import type { MetaEvent } from '@helpdock/channels';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { MetaRepository } from './meta.repository.js';
import type { MetaEventContext, MetaEventOutcome } from './meta-inbound.service.js';
import type { MetaConversationRouter } from './meta-router.js';
import { type MetaSystemLine, metaSystemLine } from './meta-text.js';

/**
 * The lines of a Meta ticket's thread that no person wrote (an unsupported
 * message, a reaction, an edit, a message unsent, a changed number), written
 * once for all three platforms so none of them can come to dedupe, word or
 * clip one differently.
 *
 * A line has a key in `ticket_messages.external_message_id`, so a redelivered
 * webhook writes it once (DOMAIN-RULES §6). The key is built here and nowhere
 * else, from the platform's id for the message the line is about and never from
 * a customer's id: a conversation has one customer, and the key must survive an
 * erasure of nothing but the line's own message id (`DbContactErasureProvider`
 * clears the key of every such line of the contact's tickets).
 */

/** A reaction's emoji is one or two code points; a longer value is not one. */
export const REACTION_EMOJI_MAX_LENGTH = 32;

/** The prefix every unsent line's external id starts with, for a query that finds them (M10-08). */
export const UNSENT_ID_PREFIX = 'unsent:';

/** The `mid` an unsent line's external id names, or null for an id that is not an unsent marker's. */
export const unsentMessageId = (externalId: string): string | null =>
  externalId.startsWith(UNSENT_ID_PREFIX) && externalId.length > UNSENT_ID_PREFIX.length
    ? externalId.slice(UNSENT_ID_PREFIX.length)
    : null;

export const noteKeys = {
  /** Something Meta says it sent that Helpdock cannot show; `messageId` is that message's. */
  unsupported: (messageId: string): string => `unsupported:${messageId}`,
  /**
   * The line that marks a message unsent (DOMAIN-RULES §4.8). A ticket message
   * has no column to hold the mark, so the line names its message in the one
   * column that is unique per brand and channel: the thread finds the message
   * a line belongs to by this value (M10-08). A real mid never contains a
   * colon, so the key cannot collide with a message.
   */
  unsent: (messageId: string): string => `${UNSENT_ID_PREFIX}${messageId}`,
  /** A reaction has no id of its own: which message, which way and when. */
  reaction: (messageId: string, action: 'react' | 'unreact', at: Date): string =>
    `reaction:${messageId}:${action}:${String(at.getTime())}`,
  /** One edit of one message, by Meta's edit number or, lacking one, its time. */
  edit: (messageId: string, version: number): string => `edit:${messageId}:${String(version)}`,
  /** A change of number has no message at all: the conversation it happened in, and when. */
  numberChanged: (conversationId: string, at: Date): string =>
    `number:${conversationId}:${String(at.getTime())}`,
} as const;

/** What a line in the thread is, and the key that keeps a redelivery to one of it. */
export interface MetaNote {
  readonly line: MetaSystemLine;
  /** Null when the event carries nothing to key it on; such a line is written every time. */
  readonly key: string | null;
}

/** How a line in the thread came out. */
export type MetaNoteResult = 'written' | 'duplicate' | 'no-open-ticket';

/** What the webhook counts for a line: a line written is a handled event. */
export const noteOutcome = (result: MetaNoteResult): MetaEventOutcome => {
  switch (result) {
    case 'written':
      return { outcome: 'handled' };
    case 'duplicate':
      return { outcome: 'duplicate' };
    case 'no-open-ticket':
      return { outcome: 'ignored', reason: 'no-open-ticket' };
  }
};

/** A reaction, or one taken back, as the line the thread shows, and its key. */
export const reactionNote = (event: Extract<MetaEvent, { kind: 'reaction' }>): MetaNote => {
  const emoji = [...(event.emoji ?? '')].slice(0, REACTION_EMOJI_MAX_LENGTH).join('');
  const line: MetaSystemLine =
    event.action === 'unreact'
      ? { kind: 'reaction', emoji: null }
      : emoji === ''
        ? { kind: 'reactionPlain' }
        : { kind: 'reaction', emoji };

  return {
    line,
    key:
      event.timestamp === null
        ? null
        : noteKeys.reaction(event.messageId, event.action, event.timestamp),
  };
};

/** What the writer needs: each platform's service passes its own options. */
export interface MetaThreadNotesParts {
  readonly router: Pick<MetaConversationRouter, 'openTicket' | 'writeSystemLine'>;
  readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  readonly repository: Pick<MetaRepository, 'systemLineSeen'>;
}

/** Writes the lines, in the open ticket a message's conversation leads to. */
export class MetaThreadNotes {
  readonly #parts: MetaThreadNotesParts;

  constructor(parts: MetaThreadNotesParts) {
    this.#parts = parts;
  }

  /**
   * A line in the open ticket `ticketId` leads to, worded for its contact, once
   * however often the event arrives. `no-open-ticket` when there is none: no
   * ticket, or one that is closed or spam.
   */
  async write(
    { tx, account }: MetaEventContext,
    ticketId: string | null,
    note: MetaNote,
  ): Promise<MetaNoteResult> {
    const { router, lifecycleReads, repository } = this.#parts;
    const ticket = ticketId === null ? undefined : await router.openTicket(tx, ticketId);
    if (ticket === undefined) {
      return 'no-open-ticket';
    }
    if (note.key !== null && (await repository.systemLineSeen(tx, account.brandId, note.key))) {
      return 'duplicate';
    }

    const locale = await lifecycleReads.localeForContact(tx, account.brandId, ticket.contactId);
    await router.writeSystemLine(tx, {
      ticket,
      accountId: account.id,
      text: metaSystemLine(locale, note.line),
      ...(note.key === null ? {} : { externalMessageId: note.key }),
    });
    return 'written';
  }
}
