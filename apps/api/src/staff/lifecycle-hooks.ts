import type { Logger } from '../logging/logger.js';

/**
 * The parts of DOMAIN-RULES §12 that belong to milestones which have not
 * arrived, wired as named calls rather than left as a comment.
 *
 * | Effect | Owner |
 * |---|---|
 * | Sessions and trusted devices revoked | M0-05, done by the service |
 * | Sockets disconnected | M0-13, through the `principal.revoked` broadcast the revocation already publishes |
 * | Removed from presence | M0-13 |
 * | Removed from round-robin, open tickets handled per `on_unassign` | M1 |
 * | API keys they created revoked | M8 |
 *
 * A named no-op is worth having because it puts the missing work at the exact
 * point in the sequence where it has to happen, and because the milestone that
 * implements it changes one function instead of searching for the places that
 * should have called it. Each logs, so an operator can see the gap in the
 * log rather than only in this file.
 */

export interface StaffLifecycleEvent {
  readonly brandId: string;
  readonly userId: string;
  readonly actorId: string;
}

export interface StaffLifecycleHooks {
  onStaffDeactivated(event: StaffLifecycleEvent): Promise<void>;
  onStaffReactivated(event: StaffLifecycleEvent): Promise<void>;
  /**
   * A role or department change. It fires whether the scope widened or
   * narrowed: M1 decides which tickets to unassign by comparing what the
   * person can still see, and that comparison needs the change, not a guess
   * made here (§12, §3.3).
   */
  onStaffScopeChanged(event: StaffLifecycleEvent): Promise<void>;
}

export class LoggingStaffLifecycleHooks implements StaffLifecycleHooks {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  onStaffDeactivated(event: StaffLifecycleEvent): Promise<void> {
    return this.#pending(
      event,
      'Staff deactivated: presence and round-robin removal is M0-13 and M1; open tickets are handled per the department on_unassign setting in M1',
    );
  }

  onStaffReactivated(event: StaffLifecycleEvent): Promise<void> {
    return this.#pending(
      event,
      'Staff reactivated: round-robin membership is restored by M1 when departments carry one',
    );
  }

  onStaffScopeChanged(event: StaffLifecycleEvent): Promise<void> {
    return this.#pending(
      event,
      'Staff role or departments changed: tickets they can no longer see are unassigned per the department on_unassign setting in M1',
    );
  }

  #pending(event: StaffLifecycleEvent, message: string): Promise<void> {
    this.#logger.debug({ ...event }, message);

    return Promise.resolve();
  }
}
