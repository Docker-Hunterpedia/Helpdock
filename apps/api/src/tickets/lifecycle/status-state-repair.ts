import type { Db } from '@helpdock/db';
import { liveBrandIds } from '../../tenant/live-brands.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { TicketLifecycleRepository } from './lifecycle.repository.js';
import { enqueueTicketStatusStateResync } from './status-state-events.js';

/**
 * Before #361, remapping a status to a closed state left its tickets with no
 * `closed_at`. On worker boot, every closed-state status that still holds such
 * a ticket gets the same `ticket.status_state_resync` event a fresh edit writes,
 * so the worker closes them through the lifecycle (resolution clock met,
 * `ticket.closed`, no survey).
 *
 * Idempotent: the worker only closes tickets with no `closed_at`, so a boot with
 * nothing to repair writes nothing and a repaired status drops out.
 *
 * Returns how many events it wrote.
 */
export const repairClosedStatusTickets = async (
  db: Db,
  repository: TicketLifecycleRepository = new TicketLifecycleRepository(),
  now: Date = new Date(),
): Promise<number> => {
  let written = 0;
  for (const brandId of await liveBrandIds(db, 'not-deleted')) {
    await withSystemJob(db, brandId, 'ticket.status_state_repair.boot', async (tx) => {
      for (const statusId of await repository.closedStatusesWithOpenTickets(tx)) {
        await enqueueTicketStatusStateResync(tx, brandId, {
          statusId,
          at: now,
          actorType: 'system',
          actorId: 'status-state-repair',
        });
        written += 1;
      }
    });
  }

  return written;
};
