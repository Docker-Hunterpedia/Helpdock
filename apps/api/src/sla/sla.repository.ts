import {
  auditLog,
  brands,
  businessHours,
  type DbTransaction,
  departments,
  holidays,
  type NewHolidayRow,
  type NewSlaPolicyRow,
  type SlaPolicyRow,
  slaPolicies,
  type Ticket as TicketRow,
  type TicketSlaClockRow,
  type TicketStatus as TicketStatusRow,
  ticketMessages,
  ticketSlaClocks,
  ticketStatuses,
  tickets,
  users,
} from '@helpdock/db';
import {
  type BrandSettings,
  type BusinessHours,
  parseBrandSettings,
  slaConditionSchema,
  slaEscalationStepSchema,
  slaTargetsSchema,
  type WeeklyHours,
  weeklyHoursSchema,
} from '@helpdock/schemas';
import { and, asc, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from './clock.js';
import type { MatchablePolicy } from './policy-match.js';
import type { TicketSlaColumns } from './ticket-clocks.js';

/**
 * Every statement M3-01 and M3-02 make. Like `TicketRepository`, none filters
 * by brand or department: the transaction's `app.*` settings and the policies
 * of DOMAIN-RULES §1.3 do. `brands` is global, so its one read names the id.
 */

/** A policy as the engine reads it: the stored JSON parsed, or the row skipped. */
export interface StoredPolicy extends MatchablePolicy {
  readonly row: SlaPolicyRow;
}

const storedPolicySchema = z.object({
  conditions: z.array(slaConditionSchema),
  targets: slaTargetsSchema,
  escalation: z.array(slaEscalationStepSchema),
});

/**
 * A row whose JSON no longer parses — edited by hand, or written by a future
 * version — applies to no ticket rather than failing every ticket write.
 */
const toPolicy = (row: SlaPolicyRow): StoredPolicy | undefined => {
  const parsed = storedPolicySchema.safeParse(row);
  if (!parsed.success) {
    return undefined;
  }

  return {
    id: row.id,
    name: row.name,
    position: row.position,
    timeMode: row.timeMode,
    conditions: parsed.data.conditions,
    targets: parsed.data.targets,
    escalation: parsed.data.escalation,
    row,
  };
};

const toClock = (row: TicketSlaClockRow): Clock & { readonly id: string } => ({
  id: row.id,
  kind: row.kind,
  cycle: row.cycle,
  isCurrent: row.isCurrent,
  policyId: row.policyId,
  targetMinutes: row.targetMinutes,
  timeMode: row.timeMode,
  startedAt: row.startedAt,
  elapsedMs: row.elapsedMs,
  checkpointAt: row.checkpointAt,
  pausedAt: row.pausedAt,
  pausedTotalMs: row.pausedTotalMs,
  dueAt: row.dueAt,
  satisfiedAt: row.satisfiedAt,
  breachedAt: row.breachedAt,
  breachCause: row.breachCause,
  stoppedAt: row.stoppedAt,
  stopReason: row.stopReason,
  firedSteps: row.firedSteps,
});

const clockValues = (clock: Clock) => ({
  kind: clock.kind,
  cycle: clock.cycle,
  isCurrent: clock.isCurrent,
  policyId: clock.policyId,
  targetMinutes: clock.targetMinutes,
  timeMode: clock.timeMode,
  startedAt: clock.startedAt,
  elapsedMs: Math.round(clock.elapsedMs),
  checkpointAt: clock.checkpointAt,
  pausedAt: clock.pausedAt,
  pausedTotalMs: Math.round(clock.pausedTotalMs),
  dueAt: clock.dueAt,
  satisfiedAt: clock.satisfiedAt,
  breachedAt: clock.breachedAt,
  breachCause: clock.breachCause,
  stoppedAt: clock.stoppedAt,
  stopReason: clock.stopReason,
  firedSteps: [...clock.firedSteps],
});

/** What the brand's calendars are built from, read in one go. */
export interface CalendarRows {
  readonly brandTimezone: string;
  readonly brandWeekly: WeeklyHours | null;
  readonly overrides: ReadonlyMap<string, BusinessHours>;
  readonly holidays: readonly {
    readonly startsOn: string;
    readonly endsOn: string;
    readonly departmentId: string | null;
  }[];
}

export interface TicketWithStatus {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
}

export class SlaRepository {
  // ------------------------------------------------------------ calendars

  async calendarRows(tx: DbTransaction, brandId: string): Promise<CalendarRows> {
    const [brand] = await tx
      .select({ timezone: brands.timezone })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    const hours = await tx.select().from(businessHours);
    const closed = await tx
      .select({
        startsOn: holidays.startsOn,
        endsOn: holidays.endsOn,
        departmentId: holidays.departmentId,
      })
      .from(holidays);

    const brandTimezone = brand?.timezone ?? 'UTC';
    let brandWeekly: WeeklyHours | null = null;
    const overrides = new Map<string, BusinessHours>();
    for (const row of hours) {
      const weekly = weeklyHoursSchema.safeParse(row.weekly);
      if (!weekly.success) {
        continue;
      }
      if (row.departmentId === null) {
        brandWeekly = weekly.data;
      } else {
        overrides.set(row.departmentId, {
          timezone: row.timezone ?? brandTimezone,
          weekly: weekly.data,
        });
      }
    }

    return { brandTimezone, brandWeekly, overrides, holidays: closed };
  }

  async listHolidays(tx: DbTransaction) {
    return tx.select().from(holidays).orderBy(asc(holidays.startsOn), asc(holidays.name));
  }

  async insertHoliday(tx: DbTransaction, values: NewHolidayRow) {
    const [row] = await tx.insert(holidays).values(values).returning();
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The holiday insert returned no row');
    }
    return row;
  }

  async deleteHoliday(tx: DbTransaction, holidayId: string) {
    const rows = await tx.delete(holidays).where(eq(holidays.id, holidayId)).returning();
    return rows[0];
  }

  async findHoliday(tx: DbTransaction, holidayId: string) {
    const [row] = await tx.select().from(holidays).where(eq(holidays.id, holidayId)).limit(1);
    return row;
  }

  /** The brand row (`department_id` null), or one department's override. */
  async upsertHours(
    tx: DbTransaction,
    brandId: string,
    departmentId: string | null,
    values: { readonly timezone: string | null; readonly weekly: WeeklyHours },
  ): Promise<void> {
    await tx
      .insert(businessHours)
      .values({ brandId, departmentId, timezone: values.timezone, weekly: values.weekly })
      .onConflictDoUpdate({
        target: [businessHours.brandId, businessHours.departmentId],
        set: { timezone: values.timezone, weekly: values.weekly, updatedAt: new Date() },
      });
  }

  async deleteOverride(tx: DbTransaction, departmentId: string): Promise<void> {
    await tx.delete(businessHours).where(eq(businessHours.departmentId, departmentId));
  }

  async setBrandTimezone(tx: DbTransaction, brandId: string, timezone: string): Promise<void> {
    await tx.update(brands).set({ timezone }).where(eq(brands.id, brandId));
  }

  async listDepartments(tx: DbTransaction) {
    return tx
      .select({ id: departments.id, name: departments.name, nameAr: departments.nameAr })
      .from(departments)
      .orderBy(asc(departments.sortOrder), asc(departments.name));
  }

  /** The brand's ticketing settings, with every key defaulted. */
  async brandSettings(tx: DbTransaction, brandId: string): Promise<BrandSettings> {
    const [row] = await tx
      .select({ settings: brands.settings })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    return parseBrandSettings(row?.settings);
  }

  async updateBrandSettings(
    tx: DbTransaction,
    brandId: string,
    settings: BrandSettings,
  ): Promise<void> {
    await tx.update(brands).set({ settings }).where(eq(brands.id, brandId));
  }

  // ------------------------------------------------------------- policies

  async policies(tx: DbTransaction): Promise<StoredPolicy[]> {
    const rows = await tx.select().from(slaPolicies).orderBy(asc(slaPolicies.position));

    return rows.flatMap((row) => toPolicy(row) ?? []);
  }

  async policyRows(tx: DbTransaction) {
    return tx
      .select({ policy: slaPolicies, updatedByName: users.name })
      .from(slaPolicies)
      .leftJoin(users, eq(users.id, slaPolicies.updatedById))
      .orderBy(asc(slaPolicies.position), asc(slaPolicies.createdAt));
  }

  async findPolicy(tx: DbTransaction, policyId: string): Promise<SlaPolicyRow | undefined> {
    const [row] = await tx.select().from(slaPolicies).where(eq(slaPolicies.id, policyId)).limit(1);
    return row;
  }

  async insertPolicy(tx: DbTransaction, values: NewSlaPolicyRow): Promise<SlaPolicyRow> {
    const [row] = await tx.insert(slaPolicies).values(values).returning();
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The policy insert returned no row');
    }
    return row;
  }

  async updatePolicy(
    tx: DbTransaction,
    policyId: string,
    values: Partial<NewSlaPolicyRow>,
  ): Promise<SlaPolicyRow | undefined> {
    const [row] = await tx
      .update(slaPolicies)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(slaPolicies.id, policyId))
      .returning();
    return row;
  }

  async deletePolicy(tx: DbTransaction, policyId: string): Promise<void> {
    await tx.delete(slaPolicies).where(eq(slaPolicies.id, policyId));
  }

  async setPolicyPosition(tx: DbTransaction, policyId: string, position: number): Promise<void> {
    await tx.update(slaPolicies).set({ position }).where(eq(slaPolicies.id, policyId));
  }

  async countPolicies(tx: DbTransaction): Promise<number> {
    const [row] = await tx.select({ n: count() }).from(slaPolicies);
    return row?.n ?? 0;
  }

  /** Open tickets whose clocks each policy runs, visible to this transaction. */
  async runningTicketsByPolicy(tx: DbTransaction): Promise<ReadonlyMap<string, number>> {
    const rows = await tx
      .select({ policyId: tickets.slaPolicyId, n: count() })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          ne(ticketStatuses.systemState, 'closed'),
          isNull(tickets.deletedAt),
          sql`${tickets.slaPolicyId} IS NOT NULL`,
        ),
      )
      .groupBy(tickets.slaPolicyId);

    return new Map(rows.flatMap((row) => (row.policyId === null ? [] : [[row.policyId, row.n]])));
  }

  // --------------------------------------------------------------- tickets

  async findTicket(tx: DbTransaction, ticketId: string): Promise<TicketWithStatus | undefined> {
    const [row] = await tx
      .select({ ticket: tickets, status: ticketStatuses })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(eq(tickets.id, ticketId))
      .limit(1);
    return row;
  }

  /** Locks the ticket row, so two writers of the same clocks queue rather than race. */
  async lockTicket(tx: DbTransaction, ticketId: string): Promise<void> {
    await tx.execute(sql`SELECT 1 FROM ${tickets} WHERE ${tickets.id} = ${ticketId} FOR UPDATE`);
  }

  /**
   * "A staff member has replied publicly already." The first message is left
   * out: on a ticket an agent typed in, it is the customer's problem in the
   * agent's words, not a reply to it.
   */
  async hasResponse(tx: DbTransaction, ticketId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          eq(ticketMessages.kind, 'public'),
          eq(ticketMessages.authorType, 'staff'),
          gt(ticketMessages.seq, 1),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Every ticket that is not closed, deleted or merged: what a recompute visits. */
  async openTicketIds(tx: DbTransaction): Promise<string[]> {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          ne(ticketStatuses.systemState, 'closed'),
          isNull(tickets.deletedAt),
          isNull(tickets.mergedIntoId),
        ),
      );
    return rows.map((row) => row.id);
  }

  /** Tickets with a current clock still counting or paused: what `sla.rebuild` visits. */
  async runningTicketIds(tx: DbTransaction): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ ticketId: ticketSlaClocks.ticketId })
      .from(ticketSlaClocks)
      .where(
        and(
          eq(ticketSlaClocks.isCurrent, true),
          isNull(ticketSlaClocks.satisfiedAt),
          isNull(ticketSlaClocks.stoppedAt),
        ),
      );
    return rows.map((row) => row.ticketId);
  }

  async countRunningTickets(tx: DbTransaction): Promise<number> {
    return (await this.runningTicketIds(tx)).length;
  }

  async writeSummary(
    tx: DbTransaction,
    ticket: TicketRow,
    columns: TicketSlaColumns & { readonly slaCycle: number },
  ): Promise<void> {
    // `updated_at` is left as it was: the list orders by it, and a clock moving
    // is not somebody working the ticket.
    await tx
      .update(tickets)
      .set({ ...columns, updatedAt: ticket.updatedAt })
      .where(eq(tickets.id, ticket.id));
  }

  // ---------------------------------------------------------------- clocks

  async currentClocks(tx: DbTransaction, ticketId: string): Promise<(Clock & { id: string })[]> {
    const rows = await tx
      .select()
      .from(ticketSlaClocks)
      .where(and(eq(ticketSlaClocks.ticketId, ticketId), eq(ticketSlaClocks.isCurrent, true)))
      .orderBy(asc(ticketSlaClocks.kind));
    return rows.map(toClock);
  }

  /** The current clocks of many tickets at once, for a page of the list. */
  async currentClocksOf(
    tx: DbTransaction,
    ticketIds: readonly string[],
  ): Promise<ReadonlyMap<string, (Clock & { id: string })[]>> {
    if (ticketIds.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select()
      .from(ticketSlaClocks)
      .where(
        and(inArray(ticketSlaClocks.ticketId, [...ticketIds]), eq(ticketSlaClocks.isCurrent, true)),
      );
    const byTicket = new Map<string, (Clock & { id: string })[]>();
    for (const row of rows) {
      byTicket.set(row.ticketId, [...(byTicket.get(row.ticketId) ?? []), toClock(row)]);
    }
    return byTicket;
  }

  /** How the initial response clock ended, for the card after a reopen (§3.5). */
  async initialResponse(tx: DbTransaction, ticketId: string) {
    const [row] = await tx
      .select({ satisfiedAt: ticketSlaClocks.satisfiedAt, breachedAt: ticketSlaClocks.breachedAt })
      .from(ticketSlaClocks)
      .where(
        and(
          eq(ticketSlaClocks.ticketId, ticketId),
          eq(ticketSlaClocks.kind, 'first_response'),
          eq(ticketSlaClocks.cycle, 0),
        ),
      )
      .limit(1);
    return row;
  }

  /** Inserts the clocks without an id and updates the rest. */
  async saveClocks(
    tx: DbTransaction,
    brandId: string,
    ticket: TicketRow,
    clocks: readonly Clock[],
  ): Promise<void> {
    for (const clock of clocks) {
      if (clock.id === undefined) {
        await tx.insert(ticketSlaClocks).values({
          ...clockValues(clock),
          brandId,
          ticketId: ticket.id,
          departmentId: ticket.departmentId,
        });
      } else {
        await tx
          .update(ticketSlaClocks)
          .set({ ...clockValues(clock), updatedAt: new Date() })
          .where(eq(ticketSlaClocks.id, clock.id));
      }
    }
  }

  // ----------------------------------------------------------------- audit

  async writeAudit(
    tx: DbTransaction,
    entry: {
      readonly brandId: string;
      readonly actorType: 'staff' | 'visitor' | 'apikey' | 'system';
      readonly actorId: string;
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly meta: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(auditLog).values(entry);
  }
}
