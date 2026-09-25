import { type DbTransaction, tickets } from '@helpdock/db';
import type { TicketTagList, TicketTagsRequest } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Principal } from '../auth/principal.js';
import { activityActorFor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { TagsService } from './tags.service.js';
import { replaceTicketTags, tagsOfTicket } from './ticket-tags.js';

/**
 * Putting tags on a ticket (M1-06).
 *
 * A **replace**, not add and remove: the request says what the ticket should
 * carry afterwards. That makes it idempotent, it is one activity row instead of
 * four when an agent changes three chips at once, and two agents editing the
 * same ticket end at one of the two sets rather than at a mixture of both.
 *
 * Every write here leaves the two rows M1-02 established. One in
 * `ticket_activity`, because a tag is a state change and REQUIREMENTS §4.1 asks
 * for every one of them with who and how; one in `outbox`, in the same
 * transaction, because DOMAIN-RULES §6 forbids a side effect that can drift
 * from the change that caused it. A replace that changes nothing writes
 * neither, so a log does not fill with `tags: [a] → [a]`.
 *
 * Which tickets this reaches is not decided here. `ticket_tags` is
 * department-scoped and the `ticket_tags_department` trigger looks the parent
 * ticket up under the caller's own policies, so a ticket in another department
 * is a 404 from the read below and an insert that could not have happened
 * anyway.
 */
export class TicketTagsService {
  readonly #tags: TagsService;

  constructor(tags: TagsService) {
    this.#tags = tags;
  }

  async list(tx: DbTransaction, ticketId: string): Promise<TicketTagList> {
    await this.#require(tx, ticketId);

    return { tags: await tagsOfTicket(tx, ticketId) };
  }

  async replace(
    tx: DbTransaction,
    brandId: string,
    principal: Principal,
    ticketId: string,
    request: TicketTagsRequest,
  ): Promise<TicketTagList> {
    const ticket = await this.#require(tx, ticketId);

    const unknown = await this.#tags.unknownIds(tx, request.tagIds);
    if (unknown.length > 0) {
      // A tag of another brand is invisible to this transaction, so "no such
      // tag" is the honest answer to both "there is no such id" and "not yours".
      throw new NotFoundException('No such tag in this brand');
    }

    const change = await replaceTicketTags(tx, {
      brandId,
      ticketId,
      departmentId: ticket.departmentId,
      tagIds: request.tagIds,
    });

    if (change.changed) {
      await writeTicketActivity(tx, {
        brandId,
        ticketId,
        departmentId: ticket.departmentId,
        actor: activityActorFor(principal),
        action: 'ticket.tags.changed',
        from: { tagIds: change.before },
        to: { tagIds: change.after },
      });

      // The ticket has moved even though none of its own columns did, for the
      // reason a reply does: the list orders by `updated_at`.
      await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticketId));

      await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, {
        ticketId,
        departmentId: ticket.departmentId,
      });
    }

    return { tags: await tagsOfTicket(tx, ticketId) };
  }

  /** The ticket's department, or a 404 — which is also what "not yours" answers. */
  async #require(tx: DbTransaction, ticketId: string): Promise<{ readonly departmentId: string }> {
    const rows = await tx
      .select({ departmentId: tickets.departmentId })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);

    const ticket = rows[0];
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }

    return ticket;
  }
}
