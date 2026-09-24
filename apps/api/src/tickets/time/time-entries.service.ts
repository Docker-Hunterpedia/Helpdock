import type { DbTransaction } from '@helpdock/db';
import type { TimeEntry, TimeEntryCreateRequest, TimeEntryList } from '@helpdock/schemas';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { principalHasPermission } from '../../auth/permissions.js';
import type { Principal } from '../../auth/principal.js';
import { TicketingFailure } from '../../brands/ticketing-failure.js';
import { TicketLifecycleRepository } from '../lifecycle/lifecycle.repository.js';
import { TicketRepository } from '../tickets.repository.js';
import { TimeEntriesRepository, type TimeEntryRow } from './time-entries.repository.js';

/**
 * Time tracking on a ticket (REQUIREMENTS §4.1, M1-12).
 *
 * **Who.** Logging is working the ticket, so it is `ticket:write` on the route
 * and every Agent may do it. Deleting is narrower: your own entries, or anybody's
 * if you hold `ticketing:manage` — the Team Leader and the Admin — because time
 * that was billed is not something a colleague should be able to take back.
 * Entries are a person's time, so only a staff principal logs any; an API key
 * has no account to log against.
 *
 * **When.** Nothing is logged while the brand has time tracking off: a manual
 * entry is refused with `time-tracking-off`, and a reply's timer is dropped
 * (`logWithReply`) so the reply itself is never refused over it.
 *
 * Everything is the request's transaction; the ticket read before a write is
 * what turns "another department's ticket" into a 404 rather than a trigger
 * error.
 */

const toTimeEntry = ({ entry, userName }: TimeEntryRow): TimeEntry => ({
  id: entry.id,
  ticketId: entry.ticketId,
  userId: entry.userId,
  userName,
  seconds: entry.seconds,
  note: entry.note,
  messageId: entry.messageId,
  createdAt: entry.createdAt.toISOString(),
});

const staffIdOf = (principal: Principal): string => {
  if (principal.type !== 'staff') {
    throw new ForbiddenException('Only a staff member logs time');
  }

  return principal.id;
};

@Injectable()
export class TimeEntriesService {
  readonly #entries: TimeEntriesRepository;
  readonly #tickets: TicketRepository;
  readonly #lifecycle: TicketLifecycleRepository;

  constructor(
    @Inject(TimeEntriesRepository) entries: TimeEntriesRepository,
    @Inject(TicketRepository) tickets: TicketRepository,
    @Inject(TicketLifecycleRepository) lifecycle: TicketLifecycleRepository,
  ) {
    this.#entries = entries;
    this.#tickets = tickets;
    this.#lifecycle = lifecycle;
  }

  async list(tx: DbTransaction, ticketId: string): Promise<TimeEntryList> {
    await this.#requireTicket(tx, ticketId);

    return {
      entries: (await this.#entries.list(tx, ticketId)).map(toTimeEntry),
      totalSeconds: await this.#entries.total(tx, ticketId),
    };
  }

  async create(
    tx: DbTransaction,
    brandId: string,
    principal: Principal,
    ticketId: string,
    request: TimeEntryCreateRequest,
  ): Promise<TimeEntryList> {
    const userId = staffIdOf(principal);
    const departmentId = await this.#requireTicket(tx, ticketId);
    if (!(await this.#trackingOn(tx, brandId))) {
      throw new TicketingFailure('time-tracking-off');
    }

    await this.#entries.insert(tx, {
      brandId,
      ticketId,
      departmentId,
      userId,
      seconds: request.seconds,
      note: request.note ?? null,
      messageId: null,
    });

    return this.list(tx, ticketId);
  }

  /**
   * The per-reply timer, written in the transaction that wrote the reply.
   * Returns whether anything was logged.
   */
  async logWithReply(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly principal: Principal;
      readonly ticketId: string;
      readonly departmentId: string;
      readonly messageId: string;
      readonly seconds: number;
    },
  ): Promise<boolean> {
    if (input.principal.type !== 'staff' || !(await this.#trackingOn(tx, input.brandId))) {
      return false;
    }

    await this.#entries.insert(tx, {
      brandId: input.brandId,
      ticketId: input.ticketId,
      departmentId: input.departmentId,
      userId: input.principal.id,
      seconds: input.seconds,
      note: null,
      messageId: input.messageId,
    });

    return true;
  }

  async remove(
    tx: DbTransaction,
    brandId: string,
    principal: Principal,
    ticketId: string,
    entryId: string,
  ): Promise<TimeEntryList> {
    const userId = staffIdOf(principal);
    await this.#requireTicket(tx, ticketId);

    const entry = await this.#entries.find(tx, entryId);
    if (entry?.ticketId !== ticketId) {
      throw new NotFoundException('No such time entry');
    }

    if (
      entry.userId !== userId &&
      !principalHasPermission(principal, brandId, 'ticketing:manage')
    ) {
      throw new ForbiddenException('Only a Team Leader or an Admin removes somebody else’s time');
    }

    await this.#entries.delete(tx, entryId);

    return this.list(tx, ticketId);
  }

  async #requireTicket(tx: DbTransaction, ticketId: string): Promise<string> {
    const found = await this.#tickets.findTicket(tx, ticketId);
    if (found === undefined) {
      throw new NotFoundException('No such ticket');
    }

    return found.ticket.departmentId;
  }

  async #trackingOn(tx: DbTransaction, brandId: string): Promise<boolean> {
    return (await this.#lifecycle.brandSettings(tx, brandId))?.timeTrackingEnabled === true;
  }
}
