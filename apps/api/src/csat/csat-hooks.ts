import type { DbTransaction } from '@helpdock/db';
import { Inject, Injectable } from '@nestjs/common';
import { type LifecycleHookEvent, TicketLifecycleHooks } from '../tickets/lifecycle/hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { enqueueCsatRequested } from './csat-events.js';

/**
 * M1-12's half of the lifecycle hooks: the survey a close deserves.
 *
 * The lifecycle has already decided "not spam, not merged" before calling
 * `onClosedForCsat` (`lifecycle.service.ts`); what is left for this hook is §2.2's
 * "if enabled", read inside the closing transaction so the survey follows the
 * setting at the moment of the close, and the outbox row that asks the worker
 * to create it. Nothing is written to `csat_responses` here: the job does that,
 * idempotently (`csat-events.ts`).
 *
 * The other two hooks are inherited unchanged, so M3-02 extends this class, or
 * the one it replaces, in the same one line of `TicketsModule`.
 */
@Injectable()
export class CsatLifecycleHooks extends TicketLifecycleHooks {
  readonly #lifecycle: TicketLifecycleRepository;

  constructor(@Inject(TicketLifecycleRepository) lifecycle: TicketLifecycleRepository) {
    super();
    this.#lifecycle = lifecycle;
  }

  override async onClosedForCsat(tx: DbTransaction, event: LifecycleHookEvent): Promise<void> {
    const settings = await this.#lifecycle.brandSettings(tx, event.brandId);
    if (settings?.csatEnabled !== true) {
      return;
    }

    await enqueueCsatRequested(tx, event.brandId, {
      ticketId: event.ticket.id,
      closedAt: (event.ticket.closedAt ?? event.at).toISOString(),
    });
  }
}
