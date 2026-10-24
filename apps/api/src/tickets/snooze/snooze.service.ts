import { departments } from '@helpdock/db';
import type { SnoozePresets } from '@helpdock/schemas';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getTx } from '../../context/request-context.js';
import { SlaRepository } from '../../sla/sla.repository.js';
import { TicketRepository } from '../tickets.repository.js';
import { departmentCalendar } from './snooze-calendar.js';
import { snoozePresets } from './snooze-presets.js';

/**
 * `GET /tickets/:id/snooze-presets` (M14-02): the Snooze menu's four items as
 * instants, against the ticket's department calendar. The client formats them,
 * so the menu shows the same instant the server will accept; the server holds
 * the calendar maths so there is one copy of it (DOMAIN-RULES §3.1).
 *
 * The ticket is read first under the reader's department policy, so a ticket
 * in another department answers 404 as its other reads do (§1.2).
 */
@Injectable()
export class SnoozeService {
  readonly #tickets: TicketRepository;
  readonly #sla: SlaRepository;

  constructor(
    @Inject(TicketRepository) tickets: TicketRepository,
    @Inject(SlaRepository) sla: SlaRepository,
  ) {
    this.#tickets = tickets;
    this.#sla = sla;
  }

  async presets(brandId: string, ticketId: string, timeZone: string): Promise<SnoozePresets> {
    const tx = getTx();
    const found = await this.#tickets.findTicket(tx, ticketId);
    if (found === undefined) {
      throw new NotFoundException('No such ticket');
    }

    const { departmentId } = found.ticket;
    const rows = await this.#sla.calendarRows(tx, brandId);
    const calendar = departmentCalendar(rows, departmentId);
    const [department] = await tx
      .select({ name: departments.name })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    const presets = snoozePresets({ now: new Date(), agentTimeZone: timeZone, calendar });

    return {
      presets: Object.entries(presets).map(([key, at]) => ({
        key: key as keyof typeof presets,
        at: at.toISOString(),
      })),
      departmentName: department?.name ?? '',
      departmentTimeZone: calendar?.timezone ?? null,
    };
  }
}
