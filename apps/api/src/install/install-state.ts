import { type Db, users } from '@helpdock/db';
import type { InstallState } from '@helpdock/schemas';

/**
 * Has anybody set this install up yet?
 *
 * The answer is derived, not stored: an install is `fresh` exactly while the
 * `users` table is empty, which is the same condition the wizard's first step
 * re-checks inside its own transaction. There is no flag to get out of step
 * with reality, and no way to reopen the wizard by editing a row.
 *
 * `users` is a global table (`GLOBAL_TABLES` in `@helpdock/db`) because sign-in
 * happens before a brand is known, so this read needs no tenant context. It is
 * one of the two places outside `StaffRepository` that reads it directly, and
 * it reads nothing but whether a row exists.
 */

export const readInstallState = async (db: Db): Promise<InstallState> => {
  const rows = await db.select({ id: users.id }).from(users).limit(1);

  return rows.length === 0 ? 'fresh' : 'configured';
};

/**
 * What to report when the question cannot be answered. A database that cannot
 * be read must never come back as `fresh`: the meta tag decides whether the
 * admin app offers to create an install admin, and "the database blinked" is
 * not a reason to offer that to whoever is looking at the page.
 */
export const INSTALL_STATE_WHEN_UNKNOWN: InstallState = 'configured';
