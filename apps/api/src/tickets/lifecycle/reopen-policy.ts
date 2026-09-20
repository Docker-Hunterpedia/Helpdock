import type { ReopenPolicy } from '@helpdock/schemas';

/**
 * [DOMAIN-RULES §2.3](../../../../../docs/planning/DOMAIN-RULES.md#23-reopen-policy):
 * what a customer reply to a closed ticket does.
 *
 * | Value | Customer reply to a closed ticket |
 * |---|---|
 * | `within_days: N` (default 7) | Reopens if `closed_at` is **less than** N days ago, otherwise creates a new ticket |
 * | `always` | Always reopens |
 * | `never` | Always creates a new ticket |
 *
 * "Less than N days ago" is taken literally, so a reply at exactly N days
 * creates a new ticket. A boundary has to fall on one side, and this is the
 * side the sentence puts it on; the test names the day either way so nobody has
 * to re-derive it.
 *
 * The window is wall-clock time, not business hours. §3.1 counts business hours
 * for SLA clocks and says so; §2.3 says "N days ago" with no such qualifier,
 * and a customer's week does not pause for a brand's holidays.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ReopenDecision =
  /** The same ticket comes back to life; §3.5's clocks restart. */
  | { readonly kind: 'reopen' }
  /** A new ticket with `parent_id`, and a system message on each side (§2.3). */
  | { readonly kind: 'continue' };

export interface ReopenInput {
  readonly policy: ReopenPolicy;
  /**
   * When the ticket was closed. Null should not happen — `applyStatusChange`
   * sets it whenever a ticket enters a closed state — but a row written before
   * that rule existed, or restored from a backup, could carry one.
   */
  readonly closedAt: Date | null;
  /** Passed in rather than read, so the decision is testable without a clock. */
  readonly now: Date;
}

/**
 * Whether the reply reopens the ticket or continues it in a new one.
 *
 * A closed ticket with no `closed_at` reopens. The alternative is to split a
 * conversation because a timestamp is missing, and of the two wrong answers
 * "the thread stayed together" is the one a customer can live with.
 */
export const decideReopen = ({ policy, closedAt, now }: ReopenInput): ReopenDecision => {
  switch (policy.kind) {
    case 'always':
      return { kind: 'reopen' };
    case 'never':
      return { kind: 'continue' };
    case 'within_days': {
      if (closedAt === null) {
        return { kind: 'reopen' };
      }

      const elapsed = now.getTime() - closedAt.getTime();
      // A `closed_at` in the future — a clock skew between replicas — is "no
      // time at all has passed", which is inside every window.
      return elapsed < policy.days * MS_PER_DAY ? { kind: 'reopen' } : { kind: 'continue' };
    }
  }
};
