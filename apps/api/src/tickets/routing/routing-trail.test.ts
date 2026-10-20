import type { TicketArrival } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { composeTrail, type TrailNames, type TrailRow, trailIds } from './routing-trail.js';

const TICKET = '0199f4b2-0000-7000-8000-000000000001';
const CLOSED = '0199f4b2-0000-7000-8000-000000000002';
const SUPPORT = '0199f4b2-0000-7000-8000-0000000000d1';
const BILLING = '0199f4b2-0000-7000-8000-0000000000d2';
const REFUNDS = '0199f4b2-0000-7000-8000-0000000000e1';
const LINA = '0199f4b2-0000-7000-8000-0000000000a1';
const RULE = '0199f4b2-0000-7000-8000-0000000000f1';
const GONE_RULE = '0199f4b2-0000-7000-8000-0000000000f2';

const ticket = { id: TICKET, channel: 'email', importSource: null } as const;

const names: TrailNames = {
  departments: new Map([
    [SUPPORT, { name: 'Support', nameAr: 'الدعم' }],
    [BILLING, { name: 'Billing', nameAr: null }],
  ]),
  teams: new Map([[REFUNDS, 'Refunds']]),
  staff: new Map([[LINA, 'Lina Haddad']]),
  rules: new Map([[RULE, 'Invoices to Billing']]),
};

const arrival: TicketArrival = {
  entry: 'mailbox',
  entryId: 'mailbox-1',
  address: 'support@acme.test',
  departmentId: SUPPORT,
  reason: 'entry_department',
};

let clock = 0;
const row = (overrides: Partial<TrailRow>): TrailRow => {
  clock += 1;
  return {
    actorType: 'system',
    actorId: 'email:mailbox-1',
    action: 'ticket.updated',
    from: null,
    to: null,
    via: 'system',
    createdAt: new Date(Date.UTC(2026, 9, 20, 14, 0, clock)),
    ...overrides,
  };
};

const created = (to: Record<string, unknown> = { arrival }): TrailRow =>
  row({ action: 'ticket.created', to: { subject: 'Invoice', ...to } });

describe('the origin', () => {
  it('reads the recorded arrival with the department named', () => {
    const trail = composeTrail(ticket, [created()], names);

    expect(trail).toEqual({
      origin: {
        kind: 'recorded',
        channel: 'email',
        entry: 'mailbox',
        address: 'support@acme.test',
        reason: 'entry_department',
        department: { id: SUPPORT, name: 'Support', nameAr: 'الدعم' },
      },
      steps: [],
    });
  });

  it('says only the channel for a ticket filed before arrival was recorded', () => {
    const trail = composeTrail({ ...ticket, channel: 'chat' }, [created({})], names);

    expect(trail.origin).toEqual({ kind: 'unrecorded', channel: 'chat' });
  });

  it('starts a continuation at the row that opened it, not at the closed ticket’s half', () => {
    const continued = row({
      action: 'ticket.continued',
      from: { ticketId: CLOSED },
      to: { ticketId: TICKET, arrival: { ...arrival, reason: 'continued_from' } },
    });

    const trail = composeTrail(ticket, [continued], names);

    expect(trail.origin).toMatchObject({ kind: 'recorded', reason: 'continued_from' });
  });

  it('says only where an imported ticket came from, whatever its rows say', () => {
    const trail = composeTrail(
      { ...ticket, importSource: 'zendesk' },
      [created(), row({ actorId: `rule:${RULE}`, via: 'rule', to: { priority: 'high' } })],
      names,
    );

    expect(trail).toEqual({ origin: { kind: 'imported', source: 'zendesk' }, steps: [] });
  });
});

describe('each actor kind', () => {
  it('names a rule by its name', () => {
    const trail = composeTrail(
      ticket,
      [
        created(),
        row({
          actorId: `rule:${RULE}`,
          via: 'rule',
          from: { departmentId: SUPPORT, teamId: null },
          to: { departmentId: BILLING, teamId: REFUNDS },
        }),
      ],
      names,
    );

    expect(trail.steps).toEqual([
      {
        at: expect.any(String),
        change: {
          kind: 'moved',
          department: { id: BILLING, name: 'Billing', nameAr: null },
          team: { id: REFUNDS, name: 'Refunds' },
        },
        by: { kind: 'rule', ruleId: RULE, name: 'Invoices to Billing' },
      },
    ]);
  });

  it('says "a rule since deleted" by leaving out the name of a rule that is gone', () => {
    const trail = composeTrail(
      ticket,
      [
        created(),
        row({
          actorId: `rule:${GONE_RULE}`,
          via: 'rule',
          from: { priority: 'medium' },
          to: { priority: 'urgent' },
        }),
      ],
      names,
    );

    expect(trail.steps[0]?.by).toEqual({ kind: 'rule', ruleId: GONE_RULE, name: null });
  });

  it('tells AI triage from the rule that queued it by `via = ai`', () => {
    const trail = composeTrail(
      ticket,
      [
        created(),
        row({
          actorId: `rule:${RULE}`,
          via: 'ai',
          from: { priority: 'medium' },
          to: { priority: 'high' },
        }),
      ],
      names,
    );

    expect(trail.steps).toEqual([
      {
        at: expect.any(String),
        change: { kind: 'priority', from: 'medium', to: 'high' },
        by: { kind: 'ai_triage', ruleId: RULE, name: 'Invoices to Billing' },
      },
    ]);
  });

  it('names the assignment mode the rotation used', () => {
    const trail = composeTrail(
      ticket,
      [
        created(),
        row({
          actorId: 'assignment',
          from: { assigneeId: null },
          to: { assigneeId: LINA, assignedBy: 'round_robin' },
        }),
      ],
      names,
    );

    expect(trail.steps).toEqual([
      {
        at: expect.any(String),
        change: { kind: 'assigned', assignee: { id: LINA, name: 'Lina Haddad' } },
        by: { kind: 'assignment', mode: 'round_robin' },
      },
    ]);
  });

  it('names an SLA escalation, and any other system change as the system', () => {
    const trail = composeTrail(
      ticket,
      [
        created(),
        row({ actorId: 'sla', from: { priority: 'high' }, to: { priority: 'urgent' } }),
        row({ actorId: 'job-7', from: { assigneeId: LINA }, to: { assigneeId: null } }),
      ],
      names,
    );

    expect(trail.steps.map((step) => [step.by, step.change])).toEqual([
      [{ kind: 'sla' }, { kind: 'priority', from: 'high', to: 'urgent' }],
      [{ kind: 'system' }, { kind: 'assigned', assignee: null }],
    ]);
  });
});

describe('where the trail ends', () => {
  it('stops at the first change by a person, and reads on past a reply', () => {
    const trail = composeTrail(
      ticket,
      [
        created(),
        row({ actorType: 'staff', actorId: LINA, via: 'ui', action: 'ticket.replied' }),
        row({ actorId: 'assignment', from: { assigneeId: null }, to: { assigneeId: LINA } }),
        row({
          actorType: 'staff',
          actorId: LINA,
          via: 'ui',
          from: { priority: 'high' },
          to: { priority: 'low' },
        }),
        row({ actorId: `rule:${RULE}`, via: 'rule', to: { priority: 'urgent' } }),
      ],
      names,
    );

    expect(trail.steps.map((step) => step.change.kind)).toEqual(['assigned']);
  });

  it('leaves out what a row names but did not move', () => {
    const trail = composeTrail(
      ticket,
      [
        created(),
        row({
          actorId: `rule:${RULE}`,
          via: 'rule',
          from: { departmentId: SUPPORT, teamId: null },
          to: { departmentId: BILLING, teamId: null },
        }),
      ],
      names,
    );

    expect(trail.steps.map((step) => step.change)).toEqual([
      { kind: 'moved', department: { id: BILLING, name: 'Billing', nameAr: null } },
    ]);
  });
});

describe('trailIds', () => {
  it('collects what the trail names, and nothing past a person’s change', () => {
    const ids = trailIds(TICKET, [
      created(),
      row({ actorId: `rule:${RULE}`, via: 'rule', to: { departmentId: BILLING, teamId: REFUNDS } }),
      row({ actorId: 'assignment', to: { assigneeId: LINA } }),
      row({ actorType: 'staff', actorId: LINA, via: 'ui', to: { departmentId: SUPPORT } }),
      row({ actorId: `rule:${GONE_RULE}`, via: 'rule', to: { priority: 'low' } }),
    ]);

    expect(ids).toEqual({
      departmentIds: new Set([SUPPORT, BILLING]),
      teamIds: new Set([REFUNDS]),
      userIds: new Set([LINA]),
      ruleIds: new Set([RULE]),
    });
  });
});
