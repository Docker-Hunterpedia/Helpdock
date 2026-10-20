import type { DbTransaction } from '@helpdock/db';
import type { RuleAction } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import type { RulesRepository } from './rules.repository.js';
import { previewActions } from './test-run.js';
import type { TicketFacts } from './ticket-facts.js';

/**
 * The action preview's assignment semantics against the engine's
 * (`actions.ts`): moving a ticket takes off an assignee who cannot follow, and
 * "round-robin" takes the assignee off so the rotation picks.
 */

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const SUPPORT = '0199f4b2-0000-7000-8000-0000000000d1';
const BILLING = '0199f4b2-0000-7000-8000-0000000000d2';
const TEAM = '0199f4b2-0000-7000-8000-0000000000e1';
const AGENT = '0199f4b2-0000-7000-8000-0000000000a1';
const tx = {} as DbTransaction;

const facts = (overrides: Partial<TicketFacts> = {}): TicketFacts => ({
  id: '0199f4b2-0000-7000-8000-0000000000c1',
  reference: '',
  subject: '',
  body: '',
  channel: 'email',
  departmentId: SUPPORT,
  teamId: null,
  assigneeId: AGENT,
  priority: 'medium',
  statusId: '0199f4b2-0000-7000-8000-0000000000f1',
  statusChangedAt: new Date(),
  tagIds: [],
  contactEmails: [],
  accountId: null,
  custom: {},
  contactId: null,
  contactLocale: null,
  inert: false,
  ...overrides,
});

const deps = (
  agentDepartments: readonly string[],
  mode: 'manual' | 'round_robin' = 'round_robin',
) => ({
  rules: { team: async () => ({ id: TEAM, departmentId: BILLING }) } as unknown as RulesRepository,
  assignment: {
    member: async () => ({
      userId: AGENT,
      name: 'Agent',
      role: 'agent',
      departmentIds: agentDepartments,
      deactivated: false,
    }),
    department: async () => ({ assignmentMode: mode }),
  } as unknown as AssignmentRepository,
});

const run = (d: ReturnType<typeof deps>, actions: RuleAction[], start: TicketFacts = facts()) =>
  previewActions(tx, BRAND, d, start, actions);

describe('previewActions assignment', () => {
  it('takes the assignee off when assign_team moves the ticket where they cannot work', async () => {
    const { simulation } = await run(deps([SUPPORT]), [{ type: 'assign_team', teamId: TEAM }]);

    expect(simulation.facts).toMatchObject({ departmentId: BILLING, assigneeId: null });
    expect([...simulation.changes]).toEqual(
      expect.arrayContaining(['department', 'assignee', 'team']),
    );
  });

  it('keeps an assignee who can follow the ticket', async () => {
    const { simulation } = await run(deps([SUPPORT, BILLING]), [
      { type: 'assign_team', teamId: TEAM },
    ]);

    expect(simulation.facts.assigneeId).toBe(AGENT);
    expect(simulation.changes.has('assignee')).toBe(false);
  });

  it('keeps the assignee when the team is in the same department', async () => {
    const same = {
      ...deps([SUPPORT]),
      rules: {
        team: async () => ({ id: TEAM, departmentId: SUPPORT }),
      } as unknown as RulesRepository,
    };

    const { simulation } = await run(same, [{ type: 'assign_team', teamId: TEAM }]);

    expect(simulation.facts.assigneeId).toBe(AGENT);
  });

  it('takes the assignee off for assign_round_robin in a department that rotates', async () => {
    const { outcomes, simulation } = await run(deps([SUPPORT]), [{ type: 'assign_round_robin' }]);

    expect(outcomes[0]?.effect).toBe('changed');
    expect(simulation.facts.assigneeId).toBeNull();
    expect(simulation.changes.has('assignee')).toBe(true);
  });

  it('leaves the assignee alone when the department is manual', async () => {
    const { outcomes, simulation } = await run(deps([SUPPORT], 'manual'), [
      { type: 'assign_round_robin' },
    ]);

    expect(outcomes[0]?.effect).toBe('unavailable');
    expect(simulation.facts.assigneeId).toBe(AGENT);
  });
});
