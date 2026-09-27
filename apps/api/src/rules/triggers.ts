import { RULE_MAX_DEPTH, type RuleStopReason, type RuleTrigger } from '@helpdock/schemas';
import type { TicketChange } from '../tickets/ticket-events.js';

/**
 * Which rule events a domain event stands for, and whether a rule may run at
 * the point of a chain it is reached at. Both pure, because both are the
 * contract the rest of M3-03 is built on: the first decides which rules are
 * even considered, the second is REQUIREMENTS §4.3's loop guard.
 */

/** The outbox events the rules module listens to. */
export const RULE_SOURCE_EVENTS = {
  created: 'ticket.created',
  updated: 'ticket.updated',
  replied: 'ticket.replied',
  closed: 'ticket.closed',
  reopened: 'ticket.reopened',
  /** M3-02's, by the name the M3 brief agreed. */
  slaWarning: 'sla.warning',
  slaBreached: 'sla.breached',
  csatReceived: 'csat.received',
} as const;

export type RuleSourceEvent = (typeof RULE_SOURCE_EVENTS)[keyof typeof RULE_SOURCE_EVENTS];

/** Who wrote the message a `ticket.replied` event is about, when the event is one. */
export interface RepliedMessage {
  readonly kind: 'public' | 'note' | 'system' | 'ai';
  readonly authorType: 'staff' | 'contact' | 'system' | 'ai';
}

const fromChanges = (changes: readonly TicketChange[] | undefined): RuleTrigger[] => {
  const triggers: RuleTrigger[] = ['ticket_updated'];
  const moved = new Set(changes ?? []);

  if (moved.has('status')) {
    triggers.push('status_changed');
  }
  if (moved.has('assignee') || moved.has('team')) {
    triggers.push('assigned');
  }
  if (moved.has('tag_added')) {
    triggers.push('tag_added');
  }

  return triggers;
};

/**
 * The rule events for one domain event. Empty means no rule is interested:
 * a note, a message a rule itself wrote, spam.
 *
 * A reply is a customer's or an agent's by its author. One written by the
 * system — a rule's own canned reply, an auto-acknowledgment — starts nothing,
 * which is also what keeps a reply rule from answering its own reply.
 */
export const triggersFor = (
  event: string,
  details: { changes?: readonly TicketChange[] | undefined; message?: RepliedMessage | undefined },
): RuleTrigger[] => {
  switch (event) {
    case RULE_SOURCE_EVENTS.created:
      return ['ticket_created'];
    case RULE_SOURCE_EVENTS.updated:
      return fromChanges(details.changes);
    case RULE_SOURCE_EVENTS.closed:
    case RULE_SOURCE_EVENTS.reopened:
      return fromChanges([...(details.changes ?? []), 'status']);
    case RULE_SOURCE_EVENTS.replied: {
      const message = details.message;
      if (message?.kind !== 'public') {
        return [];
      }
      if (message.authorType === 'contact') {
        return ['customer_replied'];
      }
      return message.authorType === 'staff' ? ['agent_replied'] : [];
    }
    case RULE_SOURCE_EVENTS.slaWarning:
      return ['sla_warning'];
    case RULE_SOURCE_EVENTS.slaBreached:
      return ['sla_breached'];
    case RULE_SOURCE_EVENTS.csatReceived:
      return ['csat_received'];
    default:
      return [];
  }
};

export type GuardDecision =
  | { readonly kind: 'run'; readonly depth: number }
  | { readonly kind: 'stop'; readonly depth: number; readonly reason: RuleStopReason };

/**
 * The depth guard. `chain` is the rules that ran before, oldest first; the run
 * being decided is at depth `chain.length + 1`.
 *
 * A rule already in the chain is a **cycle** and is stopped before it acts,
 * whatever the depth: it would do again what it did, and set off again what it
 * set off. Past {@link RULE_MAX_DEPTH} is a **depth** stop even without a
 * cycle, so three different rules can never be joined by a fourth.
 */
export const guardRun = (ruleId: string, chain: readonly string[]): GuardDecision => {
  const depth = chain.length + 1;

  if (chain.includes(ruleId)) {
    return { kind: 'stop', depth, reason: 'cycle' };
  }
  if (depth > RULE_MAX_DEPTH) {
    return { kind: 'stop', depth, reason: 'depth' };
  }

  return { kind: 'run', depth };
};
