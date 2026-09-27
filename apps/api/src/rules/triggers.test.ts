import { RULE_MAX_DEPTH } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { guardRun, triggersFor } from './triggers.js';

const A = '01924f00-0000-7000-8000-00000000000a';
const B = '01924f00-0000-7000-8000-00000000000b';
const C = '01924f00-0000-7000-8000-00000000000c';
const D = '01924f00-0000-7000-8000-00000000000d';

describe('triggersFor', () => {
  it('names a creation', () => {
    expect(triggersFor('ticket.created', {})).toEqual(['ticket_created']);
  });

  it('names the parts of an update that rules can wait for', () => {
    expect(triggersFor('ticket.updated', {})).toEqual(['ticket_updated']);
    expect(
      triggersFor('ticket.updated', { changes: ['status', 'assignee', 'tags', 'tag_added'] }),
    ).toEqual(['ticket_updated', 'status_changed', 'assigned', 'tag_added']);
    expect(triggersFor('ticket.updated', { changes: ['team'] })).toEqual([
      'ticket_updated',
      'assigned',
    ]);
    // Taking a tag off is an update, not "tag added".
    expect(triggersFor('ticket.updated', { changes: ['tags'] })).toEqual(['ticket_updated']);
  });

  it('treats a close and a reopen as status changes', () => {
    expect(triggersFor('ticket.closed', {})).toEqual(['ticket_updated', 'status_changed']);
    expect(triggersFor('ticket.reopened', { changes: ['assignee'] })).toEqual([
      'ticket_updated',
      'status_changed',
      'assigned',
    ]);
  });

  it('tells a customer reply from an agent reply, and ignores the rest', () => {
    const replied = (kind: 'public' | 'note', authorType: 'contact' | 'staff' | 'system') =>
      triggersFor('ticket.replied', { message: { kind, authorType } });

    expect(replied('public', 'contact')).toEqual(['customer_replied']);
    expect(replied('public', 'staff')).toEqual(['agent_replied']);
    // A rule's own canned reply starts nothing, so a reply rule cannot answer itself.
    expect(replied('public', 'system')).toEqual([]);
    expect(replied('note', 'staff')).toEqual([]);
    expect(triggersFor('ticket.replied', {})).toEqual([]);
  });

  it('maps the SLA and CSAT events, and nothing else', () => {
    expect(triggersFor('sla.warning', {})).toEqual(['sla_warning']);
    expect(triggersFor('sla.breached', {})).toEqual(['sla_breached']);
    expect(triggersFor('csat.received', {})).toEqual(['csat_received']);
    expect(triggersFor('ticket.spam', {})).toEqual([]);
    expect(triggersFor('ticket.note_added', {})).toEqual([]);
  });
});

describe('guardRun', () => {
  it('runs a rule at the depth after its chain', () => {
    expect(guardRun(A, [])).toEqual({ kind: 'run', depth: 1 });
    expect(guardRun(C, [A, B])).toEqual({ kind: 'run', depth: RULE_MAX_DEPTH });
  });

  it('stops a rule that would run a second time in one chain, before it acts', () => {
    // The artboard's loop: Invoices to Returns, Returns back to Billing, and
    // Invoices to Returns again.
    expect(guardRun(A, [A, B])).toEqual({ kind: 'stop', depth: 3, reason: 'cycle' });
    expect(guardRun(A, [A])).toEqual({ kind: 'stop', depth: 2, reason: 'cycle' });
  });

  it('stops a fourth rule even when it is not a cycle', () => {
    expect(guardRun(D, [A, B, C])).toEqual({ kind: 'stop', depth: 4, reason: 'depth' });
  });
});
