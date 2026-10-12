import {
  type Attachment,
  attachments,
  type DbTransaction,
  type MetaDelivery as MetaDeliveryRow,
  ticketMessages,
  tickets,
} from '@helpdock/db';
import {
  isMetaChannel,
  type MetaDeliveryList,
  type MetaPlatform,
  type MetaTicketContextResponse,
  type MetaUnsent,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm';
import type { MetaRepository } from './meta.repository.js';
import { MetaFailure } from './meta-failure.js';
import { UNSENT_ID_PREFIX, unsentMessageId } from './meta-thread-notes.js';
import { deliveryFacts, toMetaDelivery, toMetaTicketContext } from './meta-view.js';
import { closedWindowDetails, conversationWindow } from './meta-window.js';
import type { OutboundMetaService } from './outbound-meta.service.js';

/**
 * The ticket view's Meta half (M10-06): which account and customer the thread is
 * with, whether a reply may be written now, and whether each agent reply reached
 * the customer, with "Retry" for one that did not. All run in the request's
 * transaction, so a ticket outside the reader's departments is not found.
 */

export class MetaDeliveriesService {
  readonly #repository: MetaRepository;
  readonly #outbound: OutboundMetaService;
  readonly #now: () => Date;

  constructor(
    repository: MetaRepository,
    outbound: OutboundMetaService,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#outbound = outbound;
    this.#now = now;
  }

  async list(tx: DbTransaction, ticketId: string): Promise<MetaDeliveryList> {
    await requireTicket(tx, ticketId);
    return { items: await this.#deliveries(tx, ticketId) };
  }

  /**
   * The customer the thread is with, through which account, the reply window for
   * a person writing now, and each reply's delivery: one read for the ticket
   * view. A ticket that is not on a Meta channel, or has no conversation,
   * answers a null context, so the view draws nothing Meta for it.
   */
  async ticketContext(tx: DbTransaction, ticketId: string): Promise<MetaTicketContextResponse> {
    const ticket = await requireTicket(tx, ticketId);
    const target = isMetaChannel(ticket.channel)
      ? await this.#outbound.targetFor(tx, ticket, true)
      : undefined;

    return {
      context: target === undefined ? null : toMetaTicketContext(target),
      deliveries: await this.#deliveries(tx, ticketId),
      unsent: target?.account.platform === 'instagram' ? await this.#unsent(tx, ticketId) : [],
    };
  }

  /**
   * Puts a failed reply back in the queue; one that is queued or sent is left
   * alone. A **refused** one is not a failure Retry can mend: the window closed,
   * and the answer is a new reply once the customer writes again, so it is
   * refused with the same `reply-window-closed` the composer shows.
   */
  async retry(
    tx: DbTransaction,
    brandId: string,
    ticketId: string,
    deliveryId: string,
  ): Promise<void> {
    await requireTicket(tx, ticketId);
    const delivery = await this.#repository.delivery(tx, deliveryId);
    if (delivery?.ticketId !== ticketId) {
      throw new NotFoundException('No such delivery on this ticket');
    }
    if (delivery.status === 'refused') {
      throw new MetaFailure('reply-window-closed', await this.#closedDetails(tx, delivery));
    }
    await this.#outbound.retry(tx, brandId, [deliveryId]);
  }

  async #deliveries(tx: DbTransaction, ticketId: string) {
    const rows = await this.#repository.deliveriesForTicket(tx, ticketId);
    if (rows.length === 0) {
      return [];
    }

    const messageIds = rows.map((row) => row.ticketMessageId);
    const bodies = new Map(
      (
        await tx
          .select({ id: ticketMessages.id, bodyText: ticketMessages.bodyText })
          .from(ticketMessages)
          .where(inArray(ticketMessages.id, messageIds))
      ).map((row) => [row.id, row.bodyText]),
    );
    const files = new Map<string, Attachment[]>();
    for (const file of await tx
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, messageIds))
      .orderBy(asc(attachments.createdAt), asc(attachments.id))) {
      if (file.messageId !== null) {
        files.set(file.messageId, [...(files.get(file.messageId) ?? []), file]);
      }
    }
    const platforms = await this.#platformsOf(tx, rows);

    return rows.map((row) =>
      toMetaDelivery(
        row,
        deliveryFacts(
          // An account is deleted with its deliveries, so the lookup finds it.
          platforms.get(row.accountId) ?? 'whatsapp',
          bodies.get(row.ticketMessageId) ?? '',
          files.get(row.ticketMessageId) ?? [],
        ),
      ),
    );
  }

  /**
   * The messages the customer unsent, each with the line that marks it: the
   * thread draws the mark on the message. A line whose message is not on this
   * ticket (it stayed on a merged one) names nothing here and the thread keeps
   * it as a line.
   */
  async #unsent(tx: DbTransaction, ticketId: string): Promise<MetaUnsent[]> {
    const lines = await tx
      .select({
        id: ticketMessages.id,
        externalMessageId: ticketMessages.externalMessageId,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          eq(ticketMessages.kind, 'system'),
          like(ticketMessages.externalMessageId, `${UNSENT_ID_PREFIX}%`),
        ),
      )
      .orderBy(asc(ticketMessages.seq));
    const named = lines.flatMap((line) => {
      const mid = line.externalMessageId === null ? null : unsentMessageId(line.externalMessageId);
      return mid === null ? [] : [{ line, mid }];
    });
    if (named.length === 0) {
      return [];
    }

    const originals = new Map(
      (
        await tx
          .select({ id: ticketMessages.id, externalMessageId: ticketMessages.externalMessageId })
          .from(ticketMessages)
          .where(
            and(
              eq(ticketMessages.ticketId, ticketId),
              inArray(
                ticketMessages.externalMessageId,
                named.map(({ mid }) => mid),
              ),
            ),
          )
      ).map((row) => [row.externalMessageId, row.id]),
    );

    return named.flatMap(({ line, mid }) => {
      const ticketMessageId = originals.get(mid);
      return ticketMessageId === undefined
        ? []
        : [{ ticketMessageId, lineId: line.id, at: line.createdAt.toISOString() }];
    });
  }

  async #platformsOf(
    tx: DbTransaction,
    rows: readonly MetaDeliveryRow[],
  ): Promise<Map<string, MetaPlatform>> {
    const platforms = new Map<string, MetaPlatform>();
    for (const accountId of new Set(rows.map((row) => row.accountId))) {
      const account = await this.#repository.account(tx, accountId);
      if (account !== undefined) {
        platforms.set(accountId, account.platform);
      }
    }
    return platforms;
  }

  /** Where the window stands for a refused reply, or nothing when the customer has written since. */
  async #closedDetails(tx: DbTransaction, delivery: MetaDeliveryRow) {
    const conversation = await this.#repository.conversation(
      tx,
      delivery.accountId,
      delivery.customerId,
    );
    const account = await this.#repository.account(tx, delivery.accountId);
    if (conversation === undefined || account === undefined) {
      return undefined;
    }
    const [message] = await tx
      .select({ authorType: ticketMessages.authorType })
      .from(ticketMessages)
      .where(eq(ticketMessages.id, delivery.ticketMessageId))
      .limit(1);
    const window = conversationWindow({
      conversation,
      account,
      personAuthored: message?.authorType === 'staff',
      now: this.#now(),
    });

    return window.state === 'closed'
      ? closedWindowDetails(account.platform, conversation, window)
      : undefined;
  }
}

const requireTicket = async (
  tx: DbTransaction,
  ticketId: string,
): Promise<{ id: string; contactId: string | null; departmentId: string; channel: string }> => {
  const rows = await tx
    .select({
      id: tickets.id,
      contactId: tickets.contactId,
      departmentId: tickets.departmentId,
      channel: tickets.channel,
    })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
    .limit(1);
  const ticket = rows[0];
  if (ticket === undefined) {
    throw new NotFoundException('No such ticket');
  }
  return ticket;
};
