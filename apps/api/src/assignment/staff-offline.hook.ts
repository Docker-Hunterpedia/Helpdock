import { type Db, withSystem } from '@helpdock/db';
import type { StaffOfflineHook } from '../realtime/staff-offline.hook.js';
import { AssignmentRepository } from './assignment.repository.js';
import { enqueueStaffOffline } from './assignment-events.js';

/**
 * M1-07's implementation of M0-13's `STAFF_OFFLINE_HOOK`: somebody's last
 * socket in a brand went, so start the auto-unassign clock (DOMAIN-RULES §12).
 *
 * The api process has no queue, and a presence change is not a request, so
 * the clock starts the way every other side effect does — an outbox row, which
 * the worker turns into one delayed `assignment.offline_unassign` job per
 * department that asks for it (`assignment-events.ts`).
 *
 * The transaction is the **system** principal of that one brand. There is no
 * request here and so no staff principal to run as; `withSystem` is the
 * audited path for exactly that (DOMAIN-RULES §1.4), and the only row it
 * writes is the outbox entry. A brand in which no department auto-unassigns
 * writes nothing at all, so a brand that never turns the feature on never
 * pays for it.
 */
export class OutboxStaffOfflineHook implements StaffOfflineHook {
  readonly #db: Db;
  readonly #repository = new AssignmentRepository();

  constructor(db: Db) {
    this.#db = db;
  }

  async onStaffOffline(userId: string, brandId: string, since: Date): Promise<void> {
    await withSystem(this.#db, brandId, async (tx) => {
      const departments = await this.#repository.departments(tx, brandId);
      if (!departments.some((department) => department.autoUnassignOffline)) {
        return;
      }

      await enqueueStaffOffline(tx, brandId, { userId, since: since.toISOString() });
    });
  }
}
