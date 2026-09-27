import type { DbTransaction } from '@helpdock/db';
import { Inject, Injectable } from '@nestjs/common';
import { CsatLifecycleHooks } from '../csat/csat-hooks.js';
import type {
  LifecycleChangeEvent,
  LifecycleHookEvent,
  LifecycleResponseEvent,
} from '../tickets/lifecycle/hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { SlaService } from './sla.service.js';

/**
 * M3-02's half of the lifecycle hooks: every moment M1-08 and M1-09 named for
 * the clocks, filled in. It extends M1-12's survey hooks, so `TicketsModule`
 * swaps one line and both keep working.
 *
 * Every moment but two is the same call — "bring the clocks in line with the
 * ticket" — because `ticket-clocks.ts` reads the ticket and decides: a close
 * resolves, a merge stops, an unmerge restarts, a status that pauses pauses.
 * The two that are not are the reopen, which starts a new cycle (§3.5), and a
 * reply, which may meet the response clock (§3.1).
 */
@Injectable()
export class SlaLifecycleHooks extends CsatLifecycleHooks {
  readonly #sla: SlaService;

  constructor(
    @Inject(TicketLifecycleRepository) lifecycle: TicketLifecycleRepository,
    @Inject(SlaService) sla: SlaService,
  ) {
    super(lifecycle);
    this.#sla = sla;
  }

  override async onCreated(tx: DbTransaction, event: LifecycleHookEvent): Promise<void> {
    await this.#sync(tx, event);
  }

  override async onChanged(tx: DbTransaction, event: LifecycleChangeEvent): Promise<void> {
    await this.#sync(tx, event, event.previousDepartmentId);
  }

  override async onResolved(tx: DbTransaction, event: LifecycleHookEvent): Promise<void> {
    await this.#sync(tx, event);
  }

  override async onMerged(tx: DbTransaction, event: LifecycleHookEvent): Promise<void> {
    await this.#sync(tx, event);
  }

  override async onUnmerged(
    tx: DbTransaction,
    event: LifecycleHookEvent & { readonly mergedMs: number },
  ): Promise<void> {
    await this.#sync(tx, event);
  }

  override async onReopened(tx: DbTransaction, event: LifecycleHookEvent): Promise<void> {
    await this.#sla.reopen(tx, {
      brandId: event.brandId,
      ticketId: event.ticket.id,
      at: event.at,
    });
  }

  override async onResponded(tx: DbTransaction, event: LifecycleResponseEvent): Promise<void> {
    await this.#sla.recordResponse(tx, {
      brandId: event.brandId,
      ticketId: event.ticket.id,
      at: event.at,
      by: event.by,
      ...(event.countsAsResponse === undefined ? {} : { countsAsResponse: event.countsAsResponse }),
    });
  }

  async #sync(
    tx: DbTransaction,
    event: LifecycleHookEvent,
    previousDepartmentId?: string,
  ): Promise<void> {
    await this.#sla.sync(tx, {
      brandId: event.brandId,
      ticketId: event.ticket.id,
      at: event.at,
      previousDepartmentId,
    });
  }
}
