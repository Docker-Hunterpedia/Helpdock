import type { TicketSystemState } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_EVENTS,
  type LifecycleEvent,
  SYSTEM_STATES,
  TRANSITIONS,
  type TransitionOutcome,
  transitionFor,
} from './transitions.js';

/**
 * DOMAIN-RULES §2.2, typed out from the document rather than imported from the
 * code under test.
 *
 * That duplication is the point. A test that asserted `TRANSITIONS` equals
 * itself would pass whatever the table said; this one fails when a cell is
 * changed without the document changing with it, which is the only failure mode
 * a transition table really has. Every cell is here, so the exhaustiveness is
 * visible rather than computed.
 *
 * | Current state | Event | Result |
 * |---|---|---|
 * | any open-like | Customer public reply | default open status, `awaiting_customer` cleared |
 * | `open` | Agent public reply, toggle on | Awaiting customer |
 * | any | Agent sets status | that status |
 * | any open-like | Agent closes | closed |
 * | `closed` | Customer reply | reopen policy (§2.3) |
 * | `closed` | Agent reopens | open |
 * | any | Marked spam | Spam |
 * | any | Merged | Merged |
 * | any | Soft-deleted by Admin | hidden |
 */
const EXPECTED: Record<TicketSystemState, Record<LifecycleEvent, TransitionOutcome>> = {
  open: {
    'customer.reply': { kind: 'to-default-open', clearsAwaitingCustomer: true },
    'agent.reply': { kind: 'to-awaiting-customer' },
    'agent.status': { kind: 'to-requested' },
    'agent.close': { kind: 'close' },
    'agent.reopen': { kind: 'refused', reason: 'ticket-not-closed' },
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  },
  on_hold: {
    'customer.reply': { kind: 'to-default-open', clearsAwaitingCustomer: true },
    'agent.reply': { kind: 'to-requested' },
    'agent.status': { kind: 'to-requested' },
    'agent.close': { kind: 'close' },
    'agent.reopen': { kind: 'refused', reason: 'ticket-not-closed' },
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  },
  escalated: {
    'customer.reply': { kind: 'to-default-open', clearsAwaitingCustomer: true },
    'agent.reply': { kind: 'to-requested' },
    'agent.status': { kind: 'to-requested' },
    'agent.close': { kind: 'close' },
    'agent.reopen': { kind: 'refused', reason: 'ticket-not-closed' },
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  },
  closed: {
    'customer.reply': { kind: 'reopen-policy' },
    'agent.reply': { kind: 'to-requested' },
    'agent.status': { kind: 'to-requested' },
    'agent.close': { kind: 'to-requested' },
    'agent.reopen': { kind: 'reopen' },
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  },
};

const live = (systemState: TicketSystemState) => ({
  systemState,
  mergedIntoId: null,
  deletedAt: null,
});

describe('the transition table of DOMAIN-RULES §2.2', () => {
  it.each(SYSTEM_STATES)('answers every event from %s', (state) => {
    expect(Object.keys(TRANSITIONS[state]).sort()).toEqual([...LIFECYCLE_EVENTS].sort());
  });

  for (const state of SYSTEM_STATES) {
    for (const event of LIFECYCLE_EVENTS) {
      it(`${state} + ${event} → ${EXPECTED[state][event].kind}`, () => {
        expect(transitionFor(live(state), event)).toEqual(EXPECTED[state][event]);
      });
    }
  }
});

describe('the two facts checked before the table', () => {
  it.each(LIFECYCLE_EVENTS)('refuses %s on a merged ticket', (event) => {
    expect(
      transitionFor({ systemState: 'closed', mergedIntoId: 'a-primary', deletedAt: null }, event),
    ).toEqual({ kind: 'refused', reason: 'ticket-merged' });
  });

  it.each(LIFECYCLE_EVENTS)('refuses %s on a deleted ticket', (event) => {
    expect(
      transitionFor({ systemState: 'open', mergedIntoId: null, deletedAt: new Date() }, event),
    ).toEqual({ kind: 'refused', reason: 'ticket-deleted' });
  });

  it('answers deleted before merged, so a ticket that is both says deleted', () => {
    expect(
      transitionFor(
        { systemState: 'closed', mergedIntoId: 'a-primary', deletedAt: new Date() },
        'agent.status',
      ),
    ).toEqual({ kind: 'refused', reason: 'ticket-deleted' });
  });
});
