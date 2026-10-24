import type { OutboxEventHandler } from '@helpdock/jobs';
import { missingRequiredToClose } from '@helpdock/schemas';
import { requiredToCloseRules } from '../close-requirements.js';
import type { ActivityActor } from '../ticket-activity.js';
import { writeTicketActivity } from '../ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../ticket-events.js';
import type { TicketLifecycleRepository } from './lifecycle.repository.js';
import type { LifecycleContext, TicketLifecycleService } from './lifecycle.service.js';
import { stateExpectsClosedAt } from './status-state.js';
import {
  enqueueTicketStatusStateResync,
  TICKET_STATUS_STATE_RESYNC_BATCH,
  ticketStatusStateResyncPayloadSchema,
} from './status-state-events.js';

/**
 * The worker's half of issue #361.
 *
 * ```
 * request  →  statuses + outbox(ticket.status_state_resync)   one transaction
 * worker   →  this handler → tickets, activity, clocks, outbox(ticket.closed)  per batch
 * ```
 *
 * A status moved into a closed state owes its live tickets the close an agent
 * moving each of them by hand would owe (§2.2 row 4): `closed_at`, the
 * resolution clock met, an activity row and `ticket.closed` (so webhooks and
 * rules fire per ticket). It owes no satisfaction survey: a configuration
 * change is not a resolution. The way out of a closed state is refused by the
 * status edit while the status holds a live ticket, so there is no reopen here.
 * A change of the `pauses_sla` flag is `sla.status_resync`'s (#358).
 */

export interface StatusStateWorkerDeps {
  readonly repository: TicketLifecycleRepository;
  /** The close of §2.2, hooks included. */
  readonly lifecycle: Pick<TicketLifecycleService, 'onClosed'>;
  /** Tickets one event moves before it hands on; tests shrink it. */
  readonly batch?: number;
}

/**
 * `ticket.status_state_resync`: one batch per event; a full batch writes the
 * next event in the same transaction, so a status holding thousands of tickets
 * never holds one long transaction. The status and the tickets are read as
 * they are **now**: a status that is no longer closed, or a ticket that moved
 * out, closed or was deleted since the edit, is left alone rather than closed
 * against the person's later intent. The batch rows are locked and the update
 * re-checks status and `closed_at`.
 */
export const createStatusStateResyncHandler =
  (deps: StatusStateWorkerDeps): OutboxEventHandler =>
  async ({ brandId, payload, tx, log }) => {
    const { statusId, at, actorType, actorId, afterId } =
      ticketStatusStateResyncPayloadSchema.parse(payload);
    const limit = deps.batch ?? TICKET_STATUS_STATE_RESYNC_BATCH;

    // Locked, so two flips racing each see the other's state and the last one wins.
    const status = await deps.repository.findStatus(tx, statusId, { forUpdate: true });
    if (status === undefined) {
      log.info({ brandId, statusId }, 'status state resync skipped: the status is gone');
      return;
    }
    if (!stateExpectsClosedAt(status.systemState)) {
      return;
    }

    const batch = await deps.repository.liveTicketsToClose(tx, statusId, {
      limit,
      ...(afterId === undefined ? {} : { afterId }),
    });
    if (batch.length === 0) {
      return;
    }

    const context: LifecycleContext = {
      tx,
      brandId,
      // The tickets closed for the save that changed the state; the worker wrote
      // the rows, and `via` says so while the actor names whose save it was.
      actor: { actorType, actorId, via: 'system' } satisfies ActivityActor,
      now: at,
      withoutSurvey: true,
    };

    // M14-17: a configuration change closes through empty required-to-close
    // fields — it is a system close, never gated — and each row says which.
    const gate = await requiredToCloseRules(tx);

    for (const { id } of batch) {
      const closed = await deps.repository.closeTicketInStatus(tx, id, statusId, at);
      if (closed === undefined) {
        // Moved out, closed or deleted since the batch read it.
        continue;
      }

      const closedWithout = missingRequiredToClose(gate, closed.custom);
      await writeTicketActivity(tx, {
        brandId,
        ticketId: closed.id,
        departmentId: closed.departmentId,
        actor: context.actor,
        action: 'ticket.closed',
        from: { statusId },
        to: {
          statusId,
          closedAt: at.toISOString(),
          reason: 'status-state',
          ...(closedWithout.length === 0 ? {} : { closedWithout }),
        },
      });
      await deps.lifecycle.onClosed(context, closed, status);
      await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.closed, {
        ticketId: closed.id,
        departmentId: closed.departmentId,
      });
    }

    const last = batch.at(-1);
    if (batch.length === limit && last !== undefined) {
      await enqueueTicketStatusStateResync(tx, brandId, {
        statusId,
        at,
        actorType,
        actorId,
        afterId: last.id,
      });
    }
  };
