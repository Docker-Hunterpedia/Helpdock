import type { RelayStatus } from '@helpdock/jobs';
import type {
  ComponentStatus,
  QueueCounts,
  SystemCheck,
  SystemQueues,
  SystemRelay,
} from '@helpdock/schemas';

/**
 * The readings turned into the states the System page draws: a hue per card and
 * the two derived numbers the queue table needs.
 *
 * They are separate from the service that gathers the readings so they can be
 * read and tested as what they are — rules about when something is degraded —
 * without a database anywhere near them.
 */

/** A probe that answered slower than this is working, but not well. */
export const SLOW_CHECK_MS = 500;

/**
 * How long a relay may go without reporting before the worker is shown as
 * degraded. The relay polls every 500 ms and its Redis key lives for five
 * minutes, so a minute of silence is a worker in trouble rather than a quiet
 * install.
 */
export const RELAY_STALE_MS = 60_000;

/** One probe out of the set, by name. */
export const checkNamed = (
  checks: readonly SystemCheck[],
  name: SystemCheck['name'],
): SystemCheck | undefined => checks.find((check) => check.name === name);

/** Whether a named probe answered at all. */
export const checkReached = (checks: readonly SystemCheck[], name: SystemCheck['name']): boolean =>
  checkNamed(checks, name)?.status === 'up';

/** `ok` unless something failed, `warning` when it answered but slowly. */
export const checksStatus = (checks: readonly SystemCheck[]): ComponentStatus => {
  if (checks.some((check) => check.status === 'down')) {
    return 'error';
  }

  return checks.some((check) => check.latencyMs > SLOW_CHECK_MS) ? 'warning' : 'ok';
};

export const dependencyStatus = ({
  reachable,
  latencyMs,
  degraded = false,
}: {
  readonly reachable: boolean;
  readonly latencyMs: number;
  /** A condition that is not a failure but costs latency, such as an AOF rewrite. */
  readonly degraded?: boolean;
}): ComponentStatus => {
  if (!reachable) {
    return 'error';
  }

  return degraded || latencyMs > SLOW_CHECK_MS ? 'warning' : 'ok';
};

/**
 * The relay's heartbeat as the page states it. A cycle older than
 * {@link RELAY_STALE_MS} is reported as no report at all: a stale heartbeat and
 * a missing one mean the same thing to an operator — the worker is not running
 * — and showing a two-hour-old "0 pending" as if it were current would be worse
 * than showing nothing.
 */
export const relayView = (status: RelayStatus | null, now: number = Date.now()): SystemRelay => {
  if (status === null || now - Date.parse(status.at) > RELAY_STALE_MS) {
    return { reporting: false };
  }

  return {
    reporting: true,
    at: status.at,
    durationMs: status.durationMs,
    pending: status.pending,
    published: status.published,
    failed: status.failed,
  };
};

/**
 * The two totals the table's header and footer show: how many queues there are,
 * and how many jobs are in a failed set anywhere — the dead-letter count of
 * ARCHITECTURE §13. Both describe the whole install, not the slice being shown,
 * which is why they are computed apart from the slicing.
 */
const totalsOf = (
  counts: readonly QueueCounts[],
): Pick<SystemQueues, 'total' | 'deadLettered'> => ({
  total: counts.length,
  deadLettered: counts.reduce((failed, queue) => failed + queue.failed, 0),
});

/** The first `limit` queues, for the summary card. */
export const queuesView = (counts: readonly QueueCounts[], limit: number): SystemQueues => ({
  queues: counts.slice(0, limit),
  ...totalsOf(counts),
});

/** One page of the full list, for `GET /api/install/system/queues`. */
export const queuePageView = (
  counts: readonly QueueCounts[],
  { page, pageSize }: { readonly page: number; readonly pageSize: number },
): SystemQueues & { readonly page: number; readonly pageSize: number } => ({
  queues: counts.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
  ...totalsOf(counts),
  page,
  pageSize,
});
