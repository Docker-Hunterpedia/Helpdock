import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import type { TicketPriority, TicketSla, TicketSlaSummary } from '@helpdock/schemas';
import { writeTicketActivity } from '../tickets/ticket-activity.js';
import { buildCalendars } from './calendars.js';
import { type Clock, checkpoint } from './clock.js';
import { matchPolicy } from './policy-match.js';
import type { SlaRepository, StoredPolicy } from './sla.repository.js';
import { enqueueSlaBreached, enqueueSlaSchedule } from './sla-events.js';
import { summaryOf, ticketSlaView } from './sla-view.js';
import {
  type AppliedPolicy,
  type CalendarFor,
  isResponseClock,
  reconcileClocks,
  reopenClocks,
  respondClocks,
  summaryColumns,
  type TicketFacts,
} from './ticket-clocks.js';

/**
 * The SLA engine of DOMAIN-RULES §3 (M3-02), as the api and the worker drive
 * it. Every method takes the caller's transaction: clocks are rows, and they
 * commit or roll back with the change that moved them. What leaves the
 * database — timers, notifications — is an outbox row in the same transaction
 * (`sla-events.ts`).
 *
 * The decisions are `ticket-clocks.ts`'s; this class reads the facts they
 * need, calls them, and writes back what differs. It is a plain class so the
 * worker, which runs no Nest application, builds it with `new`.
 */

/** Who answered. `rule` counts only when the rule action says `counts_as_response` (§3.1). */
export type ResponseSource = 'staff' | 'ai' | 'rule';

export interface SlaResponse {
  readonly brandId: string;
  readonly ticketId: string;
  readonly at: Date;
  readonly by: ResponseSource;
  /** The rule action's `counts_as_response`; ignored for any other source. */
  readonly countsAsResponse?: boolean;
}

export interface SlaSync {
  readonly brandId: string;
  readonly ticketId: string;
  readonly at: Date;
  /** Set when the change moved the ticket, so what ran before counts under the old hours. */
  readonly previousDepartmentId?: string | undefined;
}

/** The actor on the activity rows the engine writes: nobody pressed a button. */
const SLA_ACTOR = { actorType: 'system', actorId: 'sla', via: 'system' } as const;

/** Policies and calendars of one brand, read once per transaction step. */
interface BrandSla {
  readonly policies: readonly StoredPolicy[];
  readonly calendarFor: CalendarFor;
}

export class SlaService {
  readonly #repository: SlaRepository;

  constructor(repository: SlaRepository) {
    this.#repository = repository;
  }

  // ------------------------------------------------------------------ writes

  /**
   * Brings a ticket's clocks in line with the ticket as it is now: start,
   * pause, resume, retarget, stop or resolve (§3.1–§3.4). Idempotent, so every
   * write path may call it after it has moved the ticket.
   */
  async sync(tx: DbTransaction, change: SlaSync): Promise<void> {
    const brand = await this.#brand(tx, change.brandId);
    await this.#syncOne(tx, brand, change);
  }

  /** §3.5: a closed ticket came back. The response clock becomes a next-response clock. */
  async reopen(tx: DbTransaction, change: SlaSync): Promise<void> {
    const brand = await this.#brand(tx, change.brandId);
    const found = await this.#repository.findTicket(tx, change.ticketId);
    if (found === undefined) {
      return;
    }
    await this.#repository.lockTicket(tx, change.ticketId);

    const before = await this.#repository.currentClocks(tx, change.ticketId);
    const facts = await this.#facts(tx, found.ticket, found.status, before, change);
    const policy = this.#applied(brand, found.ticket);
    const reopened = reopenClocks({
      clocks: before,
      cycle: found.ticket.slaCycle,
      facts,
      policy,
      calendarFor: brand.calendarFor,
      at: change.at,
    });

    await this.#write(tx, change.brandId, found.ticket, {
      before,
      after: [...reopened.retired, ...reopened.started],
      current: reopened.started,
      policyId: policy?.id ?? null,
      cycle: reopened.cycle,
    });
  }

  /**
   * A reply went out. Satisfies the running response clock when the source
   * counts (§3.1): staff always; the AI when the brand's
   * `aiCountsAsFirstResponse` is on; a rule only with `countsAsResponse`.
   * Auto-acknowledgments, out-of-hours notices, notes and CSAT messages never
   * call this. Returns whether a clock was met.
   *
   * This is the hook M3-03's "send canned response" action calls, with
   * `by: 'rule'` and the action's own flag.
   */
  async recordResponse(tx: DbTransaction, response: SlaResponse): Promise<boolean> {
    if (!(await this.#counts(tx, response))) {
      return false;
    }

    const found = await this.#repository.findTicket(tx, response.ticketId);
    if (found === undefined) {
      return false;
    }
    await this.#repository.lockTicket(tx, response.ticketId);

    const brand = await this.#brand(tx, response.brandId);
    const before = await this.#repository.currentClocks(tx, response.ticketId);
    const after = respondClocks(before, brand.calendarFor, found.ticket.departmentId, response.at);

    await this.#write(tx, response.brandId, found.ticket, {
      before,
      after,
      current: after,
      policyId: found.ticket.slaPolicyId,
      cycle: found.ticket.slaCycle,
    });

    return after.some(
      (clock) =>
        isResponseClock(clock.kind) && clock.satisfiedAt?.getTime() === response.at.getTime(),
    );
  }

  /**
   * A change to what every ticket counts in — business hours, holidays, a
   * policy. Every counting clock visible to the transaction is checkpointed
   * under the calendars in force **before** `change` runs, so the time already
   * consumed stays counted as it was (§3.3); then every open ticket is brought
   * in line with the new world.
   */
  async recompute<T>(
    tx: DbTransaction,
    brandId: string,
    at: Date,
    change: () => Promise<T>,
  ): Promise<T> {
    const old = await this.#brand(tx, brandId);
    for (const ticketId of await this.#repository.runningTicketIds(tx)) {
      const found = await this.#repository.findTicket(tx, ticketId);
      if (found === undefined) {
        continue;
      }
      const before = await this.#repository.currentClocks(tx, ticketId);
      const after = before.map((clock) =>
        checkpoint(clock, old.calendarFor(clock.timeMode, found.ticket.departmentId), at),
      );
      await this.#repository.saveClocks(tx, brandId, found.ticket, changed(before, after));
    }

    const result = await change();

    const brand = await this.#brand(tx, brandId);
    for (const ticketId of await this.#repository.openTicketIds(tx)) {
      await this.#syncOne(tx, brand, { brandId, ticketId, at });
    }

    return result;
  }

  // ------------------------------------------------------------------- reads

  /** The DetailsPanel SLA card for one ticket. */
  async view(tx: DbTransaction, brandId: string, ticket: TicketRow, at: Date): Promise<TicketSla> {
    const brand = await this.#brand(tx, brandId);
    const clocks = await this.#repository.currentClocks(tx, ticket.id);
    const policyId = ticket.slaPolicyId ?? clocks.find((clock) => clock.policyId)?.policyId;
    const policy = brand.policies.find((candidate) => candidate.id === policyId) ?? null;

    return ticketSlaView({
      clocks,
      calendarFor: brand.calendarFor,
      departmentId: ticket.departmentId,
      at,
      policy,
      initialResponse:
        ticket.slaCycle > 0 ? await this.#repository.initialResponse(tx, ticket.id) : undefined,
    });
  }

  /** The list's SlaTimer for a page of tickets: two reads, whatever the page size. */
  async summaries(
    tx: DbTransaction,
    brandId: string,
    tickets: readonly TicketRow[],
    at: Date,
  ): Promise<ReadonlyMap<string, TicketSlaSummary | null>> {
    if (tickets.length === 0) {
      return new Map();
    }
    const brand = await this.#brand(tx, brandId);
    const clocks = await this.#repository.currentClocksOf(
      tx,
      tickets.map((ticket) => ticket.id),
    );

    return new Map(
      tickets.map((ticket) => [
        ticket.id,
        summaryOf(clocks.get(ticket.id) ?? [], brand.calendarFor, ticket.departmentId, at),
      ]),
    );
  }

  /** The brand's policies and calendars, as `sla-schedule.ts` and the escalation job read them. */
  async brandContext(tx: DbTransaction, brandId: string): Promise<BrandSla> {
    return this.#brand(tx, brandId);
  }

  // ---------------------------------------------------------------- internals

  async #syncOne(tx: DbTransaction, brand: BrandSla, change: SlaSync): Promise<void> {
    const found = await this.#repository.findTicket(tx, change.ticketId);
    if (found === undefined) {
      return;
    }
    await this.#repository.lockTicket(tx, change.ticketId);

    const before = await this.#repository.currentClocks(tx, change.ticketId);
    const facts = await this.#facts(tx, found.ticket, found.status, before, change);
    const policy = this.#applied(brand, found.ticket);
    const after = reconcileClocks({
      clocks: before,
      cycle: found.ticket.slaCycle,
      facts,
      policy,
      calendarFor: brand.calendarFor,
      at: change.at,
    });
    const closed = found.status.systemState === 'closed' || facts.merged || facts.deleted;

    await this.#write(tx, change.brandId, found.ticket, {
      before,
      after,
      current: after,
      policyId: closed ? found.ticket.slaPolicyId : (policy?.id ?? null),
      cycle: found.ticket.slaCycle,
    });
  }

  /**
   * Writes the clocks that changed, the ticket's summary columns, the activity
   * and `sla.breached` rows for a breach a change caused (§3.3), and one
   * `sla.schedule` row so the worker re-adds the timers.
   */
  async #write(
    tx: DbTransaction,
    brandId: string,
    ticket: TicketRow,
    next: {
      readonly before: readonly Clock[];
      readonly after: readonly Clock[];
      readonly current: readonly Clock[];
      readonly policyId: string | null;
      readonly cycle: number;
    },
  ): Promise<void> {
    const writes = changed(next.before, next.after);
    await this.#repository.saveClocks(tx, brandId, ticket, writes);

    for (const clock of writes) {
      const previous = next.before.find(
        (candidate) => candidate.id === clock.id && clock.id !== undefined,
      );
      if (
        clock.breachCause === 'change' &&
        clock.breachedAt !== null &&
        previous?.breachedAt == null
      ) {
        await writeTicketActivity(tx, {
          brandId,
          ticketId: ticket.id,
          departmentId: ticket.departmentId,
          actor: SLA_ACTOR,
          action: 'ticket.sla.breached',
          to: { clock: clock.kind, cause: 'change' },
        });
        await enqueueSlaBreached(tx, brandId, {
          ticketId: ticket.id,
          departmentId: ticket.departmentId,
          clock: clock.kind,
          cause: 'change',
        });
      }
    }

    const columns = { ...summaryColumns(next.current, next.policyId), slaCycle: next.cycle };
    if (writes.length > 0 || differs(ticket, columns)) {
      await this.#repository.writeSummary(tx, ticket, columns);
    }
    if (writes.length > 0) {
      await enqueueSlaSchedule(tx, brandId, [ticket.id]);
    }
  }

  async #facts(
    tx: DbTransaction,
    ticket: TicketRow,
    status: TicketStatusRow,
    clocks: readonly Clock[],
    change: SlaSync,
  ): Promise<TicketFacts> {
    const needsResponseAnswer =
      ticket.slaCycle === 0 && !clocks.some((clock) => isResponseClock(clock.kind));

    return {
      departmentId: ticket.departmentId,
      previousDepartmentId: change.previousDepartmentId,
      systemState: status.systemState,
      pausesSla: status.pausesSla,
      excludedFromReports: status.excludedFromReports,
      merged: ticket.mergedIntoId !== null,
      deleted: ticket.deletedAt !== null,
      responded: needsResponseAnswer ? await this.#repository.hasResponse(tx, ticket.id) : false,
    };
  }

  #applied(brand: BrandSla, ticket: TicketRow): AppliedPolicy | null {
    const policy = matchPolicy(brand.policies, {
      departmentId: ticket.departmentId,
      priority: ticket.priority as TicketPriority,
    });

    return policy === null
      ? null
      : { id: policy.id, timeMode: policy.timeMode, target: policy.targets[ticket.priority] };
  }

  async #brand(tx: DbTransaction, brandId: string): Promise<BrandSla> {
    const [policies, rows] = await Promise.all([
      this.#repository.policies(tx),
      this.#repository.calendarRows(tx, brandId),
    ]);

    return { policies, calendarFor: buildCalendars(rows) };
  }

  async #counts(tx: DbTransaction, response: SlaResponse): Promise<boolean> {
    switch (response.by) {
      case 'staff':
        return true;
      case 'rule':
        return response.countsAsResponse === true;
      case 'ai':
        return (await this.#repository.brandSettings(tx, response.brandId)).aiCountsAsFirstResponse;
    }
  }
}

/** The clocks whose stored values differ from what was read. */
const changed = (before: readonly Clock[], after: readonly Clock[]): Clock[] =>
  after.filter((clock) => {
    if (clock.id === undefined) {
      return true;
    }
    const previous = before.find((candidate) => candidate.id === clock.id);
    return previous === undefined || fingerprint(previous) !== fingerprint(clock);
  });

const fingerprint = (clock: Clock): string =>
  JSON.stringify({
    ...clock,
    elapsedMs: Math.round(clock.elapsedMs),
    pausedTotalMs: Math.round(clock.pausedTotalMs),
  });

const differs = (
  ticket: TicketRow,
  columns: ReturnType<typeof summaryColumns> & { readonly slaCycle: number },
): boolean =>
  ticket.slaPolicyId !== columns.slaPolicyId ||
  ticket.slaBreached !== columns.slaBreached ||
  ticket.slaCycle !== columns.slaCycle ||
  ticket.firstResponseDueAt?.getTime() !== columns.firstResponseDueAt?.getTime() ||
  ticket.resolutionDueAt?.getTime() !== columns.resolutionDueAt?.getTime();
