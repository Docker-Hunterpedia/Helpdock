import type { DbTransaction } from '@helpdock/db';
import type {
  BusinessCalendar,
  BusinessHours,
  BusinessHoursOverview,
  BusinessHoursUpdateRequest,
  Holiday,
  HolidayCreateRequest,
  TicketingRefusal,
} from '@helpdock/schemas';
import { holidayCreateRequestSchema } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { DepartmentActor } from '../brands/department-scope.js';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { getTx } from '../context/request-context.js';
import type { ActivityActor } from '../tickets/ticket-activity.js';
import { brandCalendar, buildCalendars } from './calendars.js';
import type { SlaRepository } from './sla.repository.js';
import type { SlaService } from './sla.service.js';
import { holidayRefusal, hoursUpdateRefusal } from './sla-scope.js';

/**
 * M3-01: business hours, holidays and time zones per brand and, optionally,
 * per department (REQUIREMENTS §4.2).
 *
 * Two audiences. The Business hours tab reads and saves through
 * {@link overview}, {@link update} and the holiday methods; every save runs
 * inside {@link SlaService.recompute}, so the time clocks have already counted
 * stays counted under the old hours and only what is left moves ("Saving
 * recomputes due times on the open tickets these hours cover; time already
 * counted is kept").
 *
 * And the rest of the api, through {@link calendarFor}: M2's out-of-hours
 * auto-reply and M3-04's "business hours" condition ask the same question the
 * clocks do, and get the same answer.
 */

/** Everything a write here is told about the request it serves. */
export interface SlaAdminContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  /** Role and departments, for the scope rules of `sla-scope.ts`. */
  readonly actor: DepartmentActor;
  /** The same person, as the audit trail names them. */
  readonly auditActor: ActivityActor;
  readonly now: Date;
}

export class BusinessHoursService {
  readonly #repository: SlaRepository;
  readonly #sla: SlaService;

  constructor(repository: SlaRepository, sla: SlaService) {
    this.#repository = repository;
    this.#sla = sla;
  }

  /**
   * The calendar a ticket in `departmentId` counts in: the department's own
   * hours and zone if it has them, otherwise the brand's, with the holidays
   * that apply to it. `null` asks for the brand's own calendar.
   *
   * Feed it to `isWithinBusinessHours(calendar, at)` or
   * `addBusinessTime(calendar, from, minutes)` from `@helpdock/schemas`. The
   * transaction defaults to the request's; a worker passes its own.
   */
  async calendarFor(
    brandId: string,
    departmentId: string | null,
    tx: DbTransaction = getTx(),
  ): Promise<BusinessCalendar> {
    const rows = await this.#repository.calendarRows(tx, brandId);

    return departmentId === null
      ? brandCalendar(rows)
      : buildCalendars(rows)('business', departmentId);
  }

  async overview(tx: DbTransaction, brandId: string): Promise<BusinessHoursOverview> {
    const rows = await this.#repository.calendarRows(tx, brandId);
    const departments = await this.#repository.listDepartments(tx);
    const holidays = await this.#repository.listHolidays(tx);
    const brand = brandCalendar(rows);

    return {
      brand: { timezone: brand.timezone, weekly: brand.weekly },
      departments: departments.map((department) => ({
        departmentId: department.id,
        name: department.name,
        nameAr: department.nameAr,
        override: rows.overrides.get(department.id) ?? null,
      })),
      holidays: holidays.map(toHoliday),
      runningTickets: await this.#repository.countRunningTickets(tx),
    };
  }

  /** The tab's Save: the brand's hours and every override, together. */
  async update(
    context: SlaAdminContext,
    request: BusinessHoursUpdateRequest,
  ): Promise<BusinessHoursOverview> {
    const { tx, brandId } = context;
    const rows = await this.#repository.calendarRows(tx, brandId);
    const brand = brandCalendar(rows);
    const current: BusinessHours = { timezone: brand.timezone, weekly: brand.weekly };
    refuse(
      hoursUpdateRefusal(context.actor, { brand: current, overrides: rows.overrides }, request),
    );

    await this.#requireDepartments(
      tx,
      request.departments.map(({ departmentId }) => departmentId),
    );

    await this.#sla.recompute(tx, brandId, context.now, async () => {
      if (request.brand.timezone !== rows.brandTimezone) {
        await this.#repository.setBrandTimezone(tx, brandId, request.brand.timezone);
      }
      await this.#repository.upsertHours(tx, brandId, null, {
        timezone: null,
        weekly: request.brand.weekly,
      });
      for (const { departmentId, override } of request.departments) {
        if (override === null) {
          await this.#repository.deleteOverride(tx, departmentId);
        } else {
          await this.#repository.upsertHours(tx, brandId, departmentId, override);
        }
      }
    });

    await this.#audit(context, 'business_hours.updated', brandId, {
      timezone: request.brand.timezone,
      overrides: request.departments
        .filter(({ override }) => override !== null)
        .map(({ departmentId }) => departmentId),
    });

    return this.overview(tx, brandId);
  }

  async createHoliday(context: SlaAdminContext, input: HolidayCreateRequest): Promise<Holiday> {
    const request = holidayCreateRequestSchema.parse(input);
    refuse(holidayRefusal(context.actor, request.departmentId));
    // A foreign key is checked past row-level security, so another brand's
    // department would be accepted by the insert; this read is what refuses it.
    if (request.departmentId !== null) {
      await this.#requireDepartments(context.tx, [request.departmentId]);
    }

    const row = await this.#sla.recompute(context.tx, context.brandId, context.now, () =>
      this.#repository.insertHoliday(context.tx, {
        brandId: context.brandId,
        departmentId: request.departmentId,
        name: request.name,
        startsOn: request.startsOn,
        endsOn: request.endsOn ?? request.startsOn,
      }),
    );
    await this.#audit(context, 'holiday.created', row.id, { name: row.name });

    return toHoliday(row);
  }

  async deleteHoliday(context: SlaAdminContext, holidayId: string): Promise<void> {
    const holiday = await this.#repository.findHoliday(context.tx, holidayId);
    if (holiday === undefined) {
      throw new NotFoundException('No such holiday');
    }
    refuse(holidayRefusal(context.actor, holiday.departmentId));

    await this.#sla.recompute(context.tx, context.brandId, context.now, () =>
      this.#repository.deleteHoliday(context.tx, holidayId),
    );
    await this.#audit(context, 'holiday.deleted', holidayId, { name: holiday.name });
  }

  /** Another brand's department is invisible here, so it answers as one that does not exist. */
  async #requireDepartments(tx: DbTransaction, departmentIds: readonly string[]): Promise<void> {
    const known = new Set((await this.#repository.listDepartments(tx)).map(({ id }) => id));
    if (departmentIds.some((departmentId) => !known.has(departmentId))) {
      throw new NotFoundException('No such department in this brand');
    }
  }

  async #audit(
    context: SlaAdminContext,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.#repository.writeAudit(context.tx, {
      brandId: context.brandId,
      actorType: context.auditActor.actorType,
      actorId: context.auditActor.actorId,
      action,
      targetType: action.startsWith('holiday.') ? 'holiday' : 'brand',
      targetId,
      meta,
    });
  }
}

const refuse = (reason: TicketingRefusal | null): void => {
  if (reason !== null) {
    throw new TicketingFailure(reason);
  }
};

const toHoliday = (row: {
  readonly id: string;
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly departmentId: string | null;
}): Holiday => ({
  id: row.id,
  name: row.name,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  departmentId: row.departmentId,
});
