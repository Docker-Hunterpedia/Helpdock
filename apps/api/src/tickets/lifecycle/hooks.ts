import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { Injectable } from '@nestjs/common';

/**
 * The three places later milestones attach to the lifecycle, declared now and
 * empty now.
 *
 * M1-08 owns the transitions; it does not own the clocks (M3-02) or the survey
 * (M1-12). Two ways to leave room for them were possible: let those milestones
 * edit `lifecycle.service.ts` when they arrive, or name the moments here and
 * let them fill these in. This is the second, because the moments are
 * *decisions* — "this close resolved the ticket", "this close deserves a
 * survey", "the clocks start again now" — and deciding them is exactly what
 * §2.2 asks M1-08 for. What is done about each is somebody else's.
 *
 * Every hook runs **inside the caller's transaction**, after the ticket row has
 * moved and before the outbox row is written. That is deliberate: whatever a
 * hook writes commits with the transition or rolls back with it, and a hook
 * that needs a job enqueues it through the outbox like everything else
 * (DOMAIN-RULES §6). A hook must not enqueue a job directly and must not open a
 * transaction of its own.
 *
 * The default implementation does nothing and is what the api runs today. It is
 * a provider rather than a module-level registry so that M3-02 replaces it in
 * one line of `TicketsModule` and a test can substitute a spy without touching
 * global state.
 */

/** What every hook is told. One shape, because every hook is about one ticket moving. */
export interface LifecycleHookEvent {
  readonly brandId: string;
  readonly ticket: TicketRow;
  /** The status the ticket is in **after** the transition. */
  readonly status: TicketStatusRow;
  /** The moment the transition is being recorded at, shared by every write in it. */
  readonly at: Date;
}

@Injectable()
export class TicketLifecycleHooks {
  /**
   * A ticket reached a closed state (§2.2, §3.1). **M3-02** stops the
   * resolution clock here and records whether it was met.
   *
   * It fires for every close, including spam, because a clock that keeps
   * running on a ticket nobody will touch again is a clock that breaches. A
   * merge fires {@link onMerged} instead (M1-09), because §2.4 stops those
   * clocks without them being met.
   * What §2.4 excludes from *reports* is a separate question, and
   * `excluded_from_reports` on the status is what answers it.
   */
  async onResolved(_tx: DbTransaction, _event: LifecycleHookEvent): Promise<void> {
    await Promise.resolve();
  }

  /**
   * A close that deserves a satisfaction survey (§2.2: "CSAT scheduled (if
   * enabled, not spam, not merged)"). **M1-12** schedules it here.
   *
   * The caller decides whether it fires; see `lifecycle.service.ts`. "Not spam,
   * not merged" is read off the status's `excluded_from_reports` flag and the
   * ticket's `merged_into_id`, never off a status name, because a brand may
   * rename Spam.
   */
  async onClosedForCsat(_tx: DbTransaction, _event: LifecycleHookEvent): Promise<void> {
    await Promise.resolve();
  }

  /**
   * A closed ticket came back, by the reopen policy or by an agent (§3.5).
   * **M3-02** replaces the first-response clock with a next-response clock of
   * the same target and restarts the resolution clock from this moment,
   * preserving the original values for reporting.
   */
  async onReopened(_tx: DbTransaction, _event: LifecycleHookEvent): Promise<void> {
    await Promise.resolve();
  }

  /**
   * M1-09. A ticket was merged into another (§2.4): "secondary's clocks stop
   * and are excluded from compliance reports". **M3-02** stops both clocks here
   * without recording them as met or breached. `event.ticket.mergedAt` is the
   * moment they stopped, and `merged_into_id` with the Merged status's
   * `excluded_from_reports` is what keeps the ticket out of compliance.
   *
   * A merge does not fire {@link onResolved}: the ticket was not resolved, it
   * was folded into another one, and a resolution clock "met" by a merge would
   * flatter every report that counted it.
   */
  async onMerged(_tx: DbTransaction, _event: LifecycleHookEvent): Promise<void> {
    await Promise.resolve();
  }

  /**
   * M1-09. A merge was undone inside its 24 hours (§2.4): "clocks resume with
   * time paused during the merge excluded". `mergedMs` is how long this merge
   * lasted; `event.ticket.mergedMs` is the running total, which **M3-02** adds
   * to the clocks' paused time.
   */
  async onUnmerged(
    _tx: DbTransaction,
    _event: LifecycleHookEvent & { readonly mergedMs: number },
  ): Promise<void> {
    await Promise.resolve();
  }
}
