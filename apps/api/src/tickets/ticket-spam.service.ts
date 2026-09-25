import { contactIdentities, type DbTransaction, type Ticket as TicketRow } from '@helpdock/db';
import type { SpamSenderIdentity, Ticket, TicketSpamSender } from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Principal } from '../auth/principal.js';
import { getTx } from '../context/request-context.js';
import type { BlockListService } from '../ticketing/block-list.service.js';
import { tagsOfTicket } from '../ticketing/ticket-tags.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import type { TicketLifecycleService } from './lifecycle/lifecycle.service.js';
import { senderOf } from './spam-sender.js';
import { activityActorFor } from './ticket-activity.js';
import { toTicket } from './ticket-view.js';
import type { TicketRepository } from './tickets.repository.js';

/**
 * "Mark as spam" and "Not spam" on one ticket (M1-11, DOMAIN-RULES §2.2 row 7).
 *
 * The status half is the lifecycle's (`TicketLifecycleService.markSpam`); the
 * optional "Block sender" half is the block list's. This service is what puts
 * the two in one transaction, so a ticket is never marked without the block
 * the agent ticked, and a block is never written for a mark that was refused.
 *
 * `ticket:write` for all three routes, as §2.2's "the agent ticks 'block
 * sender'" requires: an Agent blocks a sender from a ticket without holding
 * `ticketing:manage`, and the brand setting `offerBlockSender` is how an Admin
 * takes that away.
 */
export class TicketSpamService {
  readonly #tickets: TicketRepository;
  readonly #lifecycle: TicketLifecycleService;
  readonly #blockList: BlockListService;

  constructor(
    tickets: TicketRepository,
    lifecycle: TicketLifecycleService,
    blockList: BlockListService,
  ) {
    this.#tickets = tickets;
    this.#lifecycle = lifecycle;
    this.#blockList = blockList;
  }

  /** What the dialog reads before it opens: whom to name, and whether to offer the box. */
  async sender(brandId: string, ticketId: string): Promise<TicketSpamSender> {
    const tx = getTx();
    const { ticket } = await this.#require(tx, ticketId);
    const { offerBlockSender } = await this.#blockList.settings(tx, brandId);
    const sender = await this.#senderOf(tx, ticket);

    if (sender === null) {
      return { sender: null, offered: offerBlockSender, blockable: false, blocked: false };
    }

    return {
      sender,
      offered: offerBlockSender,
      blockable: !(await this.#blockList.isOwn(tx, sender)),
      blocked: await this.#blockList.isListed(tx, brandId, sender),
    };
  }

  /**
   * `blocker` is the staff member's ticketing context when the request asked
   * to block the sender, and null when it did not: the block list records who
   * added a row, so only a person can ask for one (the controller refuses
   * anybody else).
   */
  async mark(
    brandId: string,
    principal: Principal,
    ticketId: string,
    blocker: TicketingContext | null,
  ): Promise<Ticket> {
    const tx = getTx();
    const found = await this.#require(tx, ticketId);
    const marked = await this.#lifecycle.markSpam(
      { tx, brandId, actor: activityActorFor(principal), now: new Date() },
      found.ticket,
      found.status,
    );

    if (blocker !== null) {
      await this.#block(tx, brandId, found.ticket, blocker);
    }

    return toTicket(marked.ticket, marked.status, await tagsOfTicket(tx, ticketId));
  }

  /** "Not spam": back to the brand's default open status, as an agent reopen. */
  async unmark(brandId: string, principal: Principal, ticketId: string): Promise<Ticket> {
    const tx = getTx();
    const found = await this.#require(tx, ticketId);
    const landed = await this.#lifecycle.unmarkSpam(
      { tx, brandId, actor: activityActorFor(principal), now: new Date() },
      found.ticket,
      found.status,
    );

    return toTicket(landed.ticket, landed.status, await tagsOfTicket(tx, ticketId));
  }

  // ------------------------------------------------------------------

  async #block(
    tx: DbTransaction,
    brandId: string,
    ticket: TicketRow,
    blocker: TicketingContext,
  ): Promise<void> {
    const { offerBlockSender } = await this.#blockList.settings(tx, brandId);
    if (!offerBlockSender) {
      throw new ConflictException('This brand does not block senders from a ticket');
    }

    const sender = await this.#senderOf(tx, ticket);
    if (sender === null) {
      throw new BadRequestException('This ticket has no sender that can be blocked');
    }

    await this.#blockList.blockFromTicket(blocker, sender, ticket.id);
  }

  async #senderOf(tx: DbTransaction, ticket: TicketRow): Promise<SpamSenderIdentity | null> {
    if (ticket.contactId === null) {
      return null;
    }

    const identities = await tx
      .select({
        kind: contactIdentities.kind,
        value: contactIdentities.value,
        createdAt: contactIdentities.createdAt,
      })
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, ticket.contactId));

    return senderOf(ticket.channel, identities);
  }

  async #require(tx: DbTransaction, ticketId: string) {
    const found = await this.#tickets.findTicket(tx, ticketId);
    if (found === undefined) {
      // Another department's ticket answers exactly as a missing one does
      // (DOMAIN-RULES §1.2).
      throw new NotFoundException('No such ticket');
    }

    return found;
  }
}
