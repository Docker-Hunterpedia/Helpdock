import { type RequestContext, requireRequestContext } from './request-context.js';

/**
 * Work that belongs after the commit, not inside the transaction.
 *
 * A request's transaction is the unit everything inside it rolls back with
 * (DOMAIN-RULES §1.3). A side effect outside the database that the writes only
 * make sense *after* — deleting the bucket folder a row has just stopped
 * pointing at, for one — must not run while the transaction can still fail: a
 * rollback then leaves the row pointing at a deleted file. `runAfterCommit`
 * queues such work on the request; the tenant interceptor drains it once
 * `withTenant` has resolved, which is after the commit. A rollback drops the
 * queue, and the periodic sweep of whatever the request was replacing (the
 * photo sweep, `staff/photo-sweep.job.ts`) picks up what nobody points at any
 * more.
 *
 * A queued callback answers for its own failures and never throws: the response
 * has already been committed by the time it runs, so there is nothing left to
 * turn into an error page.
 */

/** Queues `fn` to run once this request's transaction has committed. */
export const runAfterCommit = (fn: () => Promise<void>): void => {
  requireRequestContext().postCommit.push(fn);
};

/**
 * Runs what the request queued. Only the tenant interceptor calls this, after
 * its transaction has committed; the callbacks are best effort, so one failing
 * does not stop the others.
 */
export const drainPostCommit = async (context: RequestContext): Promise<void> => {
  const queued = [...context.postCommit];
  context.postCommit.length = 0;
  await Promise.all(queued.map((fn) => fn().catch(() => undefined)));
};
