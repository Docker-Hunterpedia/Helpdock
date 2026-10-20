import type { TicketRouting } from '@helpdock/schemas';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getTx } from '../../context/request-context.js';
import { TicketRepository } from '../tickets.repository.js';
import { readTrailNames, readTrailRows } from './routing.repository.js';
import { composeTrail, trailIds } from './routing-trail.js';

/**
 * `GET /tickets/:id/routing` (M14-08): the trail, read in the request's own
 * transaction. The ticket is read first under the reader's department policy,
 * so a ticket in another department answers 404 exactly as its other reads do
 * (DOMAIN-RULES §1.2), and its activity is department-scoped by the same
 * policy.
 */
@Injectable()
export class TicketRoutingService {
  readonly #tickets: TicketRepository;

  constructor(@Inject(TicketRepository) tickets: TicketRepository) {
    this.#tickets = tickets;
  }

  async trail(brandId: string, ticketId: string): Promise<TicketRouting> {
    const tx = getTx();
    const found = await this.#tickets.findTicket(tx, ticketId);
    if (found === undefined) {
      throw new NotFoundException('No such ticket');
    }
    const { ticket } = found;
    const rows = ticket.importSource === null ? await readTrailRows(tx, ticketId) : [];
    const names = await readTrailNames(tx, brandId, trailIds(ticketId, rows));

    return composeTrail(
      { id: ticket.id, channel: ticket.channel, importSource: ticket.importSource },
      rows,
      names,
    );
  }
}
