import { describe, expect, it } from 'vitest';
import {
  effectiveSystemState,
  stateExpectsClosedAt,
  statusStateTransitionFor,
} from './status-state.js';

/**
 * Which side of the closed boundary a status edit crosses, and which tickets
 * that puts in the batch (issue #361, DOMAIN-RULES §2.2 and §3.5).
 */

describe('statusStateTransitionFor', () => {
  it('closes when the state enters closed from any open-like state', () => {
    expect(statusStateTransitionFor('open', 'closed')).toBe('close');
    expect(statusStateTransitionFor('on_hold', 'closed')).toBe('close');
    expect(statusStateTransitionFor('escalated', 'closed')).toBe('close');
  });

  it('reopens when the state leaves closed for any open-like state', () => {
    expect(statusStateTransitionFor('closed', 'open')).toBe('reopen');
    expect(statusStateTransitionFor('closed', 'on_hold')).toBe('reopen');
    expect(statusStateTransitionFor('closed', 'escalated')).toBe('reopen');
  });

  it('moves nothing between the open-like states', () => {
    expect(statusStateTransitionFor('open', 'on_hold')).toBe('none');
    expect(statusStateTransitionFor('open', 'escalated')).toBe('none');
    expect(statusStateTransitionFor('on_hold', 'open')).toBe('none');
    expect(statusStateTransitionFor('on_hold', 'escalated')).toBe('none');
    expect(statusStateTransitionFor('escalated', 'open')).toBe('none');
    expect(statusStateTransitionFor('escalated', 'on_hold')).toBe('none');
  });

  it('moves nothing when the state does not change', () => {
    for (const state of ['open', 'on_hold', 'escalated', 'closed'] as const) {
      expect(statusStateTransitionFor(state, state)).toBe('none');
    }
  });
});

describe('stateExpectsClosedAt', () => {
  it('holds closed_at only in the closed state', () => {
    expect(stateExpectsClosedAt('closed')).toBe(true);
    expect(stateExpectsClosedAt('open')).toBe(false);
    expect(stateExpectsClosedAt('on_hold')).toBe(false);
    expect(stateExpectsClosedAt('escalated')).toBe(false);
  });
});

describe('effectiveSystemState', () => {
  const closedAt = new Date('2026-10-23T10:00:00Z');

  it('reads a ticket not yet reached by a status close as open', () => {
    expect(effectiveSystemState({ closedAt: null }, { systemState: 'closed' })).toBe('open');
  });

  it('reads a ticket with a closed_at in a closed status as closed', () => {
    expect(effectiveSystemState({ closedAt }, { systemState: 'closed' })).toBe('closed');
  });

  // Deleting a status leaves closed_at on the tickets it moves to Open (1.0 data).
  it('reads a ticket with a leftover closed_at in an open status as open', () => {
    expect(effectiveSystemState({ closedAt }, { systemState: 'open' })).toBe('open');
  });

  it('keeps the open-like state of an open ticket', () => {
    expect(effectiveSystemState({ closedAt: null }, { systemState: 'on_hold' })).toBe('on_hold');
    expect(effectiveSystemState({ closedAt: null }, { systemState: 'escalated' })).toBe(
      'escalated',
    );
  });
});
