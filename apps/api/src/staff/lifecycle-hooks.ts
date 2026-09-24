import type { DbTransaction } from '@helpdock/db';
import { enqueueAccessChanged } from '../assignment/assignment-events.js';
import type { Logger } from '../logging/logger.js';

/**
 * The parts of DOMAIN-RULES §12 that belong to other deliverables, wired as
 * named calls at the exact point in the sequence where they have to happen.
 *
 * | Effect | Owner |
 * |---|---|
 * | Sessions and trusted devices revoked | M0-05, done by the service |
 * | Sockets disconnected | M0-13, through the `principal.revoked` broadcast the revocation already publishes |
 * | Removed from presence | M0-13 |
 * | Removed from round-robin, open tickets handled per `on_unassign` | M1-07, here |
 * | API keys they created revoked | M8 |
 *
 * M1-07's half is one outbox row in the caller's transaction: the worker reads
 * the person's membership as it stands after the change, unassigns every open
 * ticket they can no longer work, and applies each department's `on_unassign`
 * (`assignment/assignment-events.ts`). Leaving the rotation needs nothing
 * more — the rotation reads membership when it picks, so a deactivated person
 * is never picked again.
 */

export interface StaffLifecycleEvent {
  /** The request's transaction, so the outbox row commits with the change. */
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly userId: string;
  readonly actorId: string;
}

export interface StaffLifecycleHooks {
  onStaffDeactivated(event: StaffLifecycleEvent): Promise<void>;
  onStaffReactivated(event: StaffLifecycleEvent): Promise<void>;
  /**
   * A role or department change, or removal from the brand. It fires whether
   * the scope widened or narrowed: which tickets to unassign is decided by
   * comparing what the person can still work, and that needs the change, not a
   * guess made here (§12).
   */
  onStaffScopeChanged(event: StaffLifecycleEvent): Promise<void>;
}

export class AssignmentStaffLifecycleHooks implements StaffLifecycleHooks {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async onStaffDeactivated({ tx, brandId, userId }: StaffLifecycleEvent): Promise<void> {
    await enqueueAccessChanged(tx, brandId, userId);
  }

  onStaffReactivated({ brandId, userId, actorId }: StaffLifecycleEvent): Promise<void> {
    // Nothing to restore: rotation rows were never deleted, and the rotation
    // reads the account's state when it picks.
    this.#logger.debug({ brandId, userId, actorId }, 'Staff reactivated');

    return Promise.resolve();
  }

  async onStaffScopeChanged({ tx, brandId, userId }: StaffLifecycleEvent): Promise<void> {
    await enqueueAccessChanged(tx, brandId, userId);
  }
}
