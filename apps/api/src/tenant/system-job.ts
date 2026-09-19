import { type Db, type DbTransaction, systemContext, withTenant } from '@helpdock/db';

/**
 * The worker's half of DOMAIN-RULES §1.4: "every job payload carries `brandId`.
 * The worker opens a transaction and sets `app.brand_ids = {brandId}`,
 * `app.all_departments = true`, `app.principal_type = system` before any query."
 *
 * A job that needs several brands enqueues one child job per brand rather than
 * widening `brandIds`, which is why this takes exactly one.
 *
 * `jobId` names the job on every audit row it writes, so an operator reading
 * `audit_log` can go from a change back to the job that made it.
 */
export const withSystemJob = <T>(
  db: Db,
  brandId: string,
  jobId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> => withTenant(db, systemContext(brandId, jobId), fn);
